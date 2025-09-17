// app.js - DeFi Pool Analyzer Backend (DefiLlama version, pools with 1y+ chart data, robust throttling, persistent pool rotation)
// Author: Pumis (and Copilot)
// Requirements: Node.js, express, axios, cors, node-cron, dotenv, fs (node built-in)

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const POOLS_CACHE_FILE = './uniswapv3_pool_ids_cache.json';
const PROCESSED_INDEX_FILE = './last_processed_pool_index.json';

app.use(cors());
app.use(express.json());

// --- Health scoring algorithm ---
function calculateHealthScore(poolData) {
  const {
    tvl,
    volume24h,
    aprHistory,
    tvlHistory,
    volatility,
    liquidityDepth
  } = poolData;

  // TVL Stability Score (0-25 points)
  const tvlVariance = calculateVariance(tvlHistory);
  const tvlStability = Math.max(0, 25 - (tvlVariance * 100));

  // APR Consistency Score (0-25 points)
  const aprVariance = calculateVariance(aprHistory);
  const aprConsistency = Math.max(0, 25 - (aprVariance * 50));

  // Volume Efficiency Score (0-25 points)
  const volumeToTvlRatio = volume24h / tvl;
  const volumeEfficiency = Math.min(25, volumeToTvlRatio * 100);

  // Impermanent Loss Risk Score (0-25 points)
  const ilRisk = Math.max(0, 25 - (volatility * 50));

  const totalScore = tvlStability + aprConsistency + volumeEfficiency + ilRisk;

  return {
    totalScore: Math.min(100, Math.max(0, totalScore)),
    breakdown: {
      tvlStability,
      aprConsistency,
      volumeEfficiency,
      ilRisk
    }
  };
}

function calculateVariance(values) {
  if (!values || values.length < 2) return 0;
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  return Math.sqrt(variance) / mean; // Coefficient of variation
}

// --- DefiLlama integration for Uniswap V3 mainnet pools ---
const DEFI_LLAMA_POOLS_URL = "https://yields.llama.fi/pools";
const DEFI_LLAMA_POOL_CHART_URL = "https://yields.llama.fi/chart/";

// Helper: Checks if chart data has at least 365 distinct days
function hasYearOfData(chart) {
  if (!chart || !Array.isArray(chart.tvl)) return false;
  const DAYS_REQUIRED = 365;
  if (chart.tvl.length < DAYS_REQUIRED) return false;
  // Ensure the first entry is at least ~1y older than the last
  const first = chart.tvl[0].date;
  const last = chart.tvl[chart.tvl.length - 1].date;
  return (last - first) >= 3600 * 24 * 300; // 300 days minimum
}

async function fetchDefiLlamaUniswapV3Pools() {
  try {
    // Use a local cache if available to avoid repeated API calls
    if (fs.existsSync(POOLS_CACHE_FILE)) {
      const cached = JSON.parse(fs.readFileSync(POOLS_CACHE_FILE, 'utf8'));
      if (cached && Array.isArray(cached) && cached.length > 0) {
        console.log(`Loaded ${cached.length} Uniswap V3 mainnet pools from local cache`);
        return cached;
      }
    }

    console.log('Fetching Uniswap V3 pools from DefiLlama API...');
    const response = await axios.get(DEFI_LLAMA_POOLS_URL, { timeout: 25000 });
    // Filter to Uniswap V3 on Ethereum (mainnet)
    const allPools = response.data.data;
    const uniswapPools = allPools.filter(pool =>
      pool.project === "uniswap-v3" && pool.chain === "Ethereum"
    );
    console.log(`Found ${uniswapPools.length} Uniswap V3 mainnet pools from DefiLlama`);
    // Save to local cache
    fs.writeFileSync(POOLS_CACHE_FILE, JSON.stringify(uniswapPools, null, 2));
    return uniswapPools;
  } catch (error) {
    console.error('Error fetching DefiLlama pool data:', error.message);
    return [];
  }
}

// Get historical TVL, APR, and volume for a pool from DefiLlama chart API
async function fetchDefiLlamaPoolChart(poolId) {
  try {
    const url = DEFI_LLAMA_POOL_CHART_URL + encodeURIComponent(poolId);
    const response = await axios.get(url, { timeout: 20000 });
    return response.data.data || {};
  } catch (error) {
    if (error.response && error.response.status === 429) {
      // Wait and retry once if rate limited (simple retry logic)
      console.warn(`Rate limited on pool ${poolId}. Waiting 2.5 seconds and retrying...`);
      await delay(2500);
      try {
        const url = DEFI_LLAMA_POOL_CHART_URL + encodeURIComponent(poolId);
        const response = await axios.get(url, { timeout: 20000 });
        return response.data.data || {};
      } catch (retryError) {
        console.error(`Still rate limited or failed after retry for pool ${poolId}:`, retryError.message);
        return {};
      }
    }
    console.error(`Error fetching chart data for pool ${poolId}:`, error.message);
    return {};
  }
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// --- Pool data processing (persistent rotation, throttled, robust) ---
let cachedPools = [];
let lastUpdated = null;

function readLastProcessedIndex() {
  if (fs.existsSync(PROCESSED_INDEX_FILE)) {
    const idx = JSON.parse(fs.readFileSync(PROCESSED_INDEX_FILE, 'utf8'));
    if (typeof idx === 'number' && idx >= 0) return idx;
  }
  return 0;
}
function writeLastProcessedIndex(idx) {
  fs.writeFileSync(PROCESSED_INDEX_FILE, JSON.stringify(idx));
}

async function processPoolData() {
  try {
    console.log('Starting data processing...');
    const uniswapPools = await fetchDefiLlamaUniswapV3Pools();

    if (!Array.isArray(uniswapPools) || uniswapPools.length === 0) {
      console.error('No pools returned. Skipping processing.');
      return [];
    }

    // Only process up to 20 pools per refresh to avoid rate limiting
    const processedPools = [];
    let checked = 0;
    let added = 0;
    const POOLS_PER_REFRESH = 20;
    const DELAY_BETWEEN_REQUESTS = 1800; // 1.8 seconds (strict for DefiLlama rate limit)
    const maxHistory = 365;

    // Rotate through the pool list over time, persist index to disk
    let lastIndex = readLastProcessedIndex();
    if (lastIndex >= uniswapPools.length) lastIndex = 0;

    for (let i = 0; i < POOLS_PER_REFRESH; i++) {
      const poolIdx = (lastIndex + i) % uniswapPools.length;
      const pool = uniswapPools[poolIdx];
      checked++;
      try {
        await delay(DELAY_BETWEEN_REQUESTS);
        const chart = await fetchDefiLlamaPoolChart(pool.pool);

        if (!hasYearOfData(chart)) continue;

        const tvlHistory = Array.isArray(chart.tvl)
          ? chart.tvl.slice(-maxHistory).map(h => h.totalLiquidityUSD ?? h.tvl ?? 0)
          : [];
        const aprHistory = Array.isArray(chart.apy)
          ? chart.apy.slice(-maxHistory).map(h => h.apy ?? h.apr ?? 0)
          : [];
        const volumeHistory = Array.isArray(chart.volume)
          ? chart.volume.slice(-maxHistory).map(h => h.volume ?? 0)
          : [];
        const feesHistory = Array.isArray(chart.fees)
          ? chart.fees.slice(-maxHistory).map(h => h.fees ?? 0)
          : [];
        const dates = Array.isArray(chart.tvl)
          ? chart.tvl.slice(-maxHistory).map(e =>
              new Date(e.date * 1000).toISOString().split('T')[0]
            )
          : [];

        const tvl = pool.tvlUsd || (tvlHistory.length > 0 ? tvlHistory[tvlHistory.length - 1] : 0);
        const volume24h = pool.volumeUsd1d || (volumeHistory.length > 0 ? volumeHistory[volumeHistory.length - 1] : 0);

        const volatility = calculateVariance(tvlHistory);

        const poolData = {
          tvl,
          volume24h,
          aprHistory,
          tvlHistory,
          volatility,
          liquidityDepth: tvl / 1000000
        };

        const healthScore = calculateHealthScore(poolData);

        const processedPool = {
          pool_id: pool.pool,
          platform: 'uniswap-v3',
          token_pair: pool.symbol,
          token0_symbol: pool.symbol.split('/')[0],
          token1_symbol: pool.symbol.split('/')[1] || '',
          tvl: tvl,
          volume_24h: volume24h,
          fee_tier: pool.metadata && pool.metadata.fee ? pool.metadata.fee : null,
          health_score: healthScore.totalScore,
          tvl_stability: healthScore.breakdown.tvlStability,
          apr_consistency: healthScore.breakdown.aprConsistency,
          volume_efficiency: healthScore.breakdown.volumeEfficiency,
          il_risk_score: healthScore.breakdown.ilRisk,
          last_updated: new Date().toISOString(),
          historical_data: {
            tvl: tvlHistory,
            volume: volumeHistory,
            fees: feesHistory,
            apr: aprHistory,
            dates: dates
          }
        };

        processedPools.push(processedPool);
        added++;
      } catch (error) {
        console.error(`Error processing pool ${pool.pool}:`, error.message);
      }
    }

    // Update persistent index for rotation
    writeLastProcessedIndex((lastIndex + POOLS_PER_REFRESH) % uniswapPools.length);

    // Here, you can choose to merge processedPools into cachedPools for accumulation, or just replace on each refresh.
    // We'll accumulate pools with unique pool_id for best UX.
    // If you want to clear on every refresh, just assign processedPools to cachedPools.
    let mergedPools = Array.isArray(cachedPools) ? [...cachedPools] : [];
    for (const pool of processedPools) {
      const idx = mergedPools.findIndex(p => p.pool_id === pool.pool_id);
      if (idx >= 0) mergedPools[idx] = pool;
      else mergedPools.push(pool);
    }
    cachedPools = mergedPools;
    lastUpdated = new Date().toISOString();

    console.log(`Processed ${checked} pools, added/updated ${added} pools this run. Total cached: ${cachedPools.length}`);
    return processedPools;
  } catch (error) {
    console.error('Error in processPoolData:', error);
    return [];
  }
}

// --- API routes ---

app.get('/', (req, res) => {
  res.json({
    message: '🏊‍♂️ DeFi Pool Health Analyzer API (DefiLlama version, 1y chart only, robust throttling/rotation)',
    status: 'running',
    endpoints: {
      health: '/api/health',
      pools: '/api/pools',
      metrics: '/api/metrics',
      refresh: '/api/refresh'
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', lastUpdated });
});

app.get('/api/pools', async (req, res) => {
  try {
    // Query params: platform, minTvl, limit
    let { platform, minTvl, limit } = req.query;
    minTvl = minTvl ? parseFloat(minTvl) : 0;
    limit = limit ? parseInt(limit) : 1000;

    let pools = cachedPools;
    if (platform && platform !== 'all') {
      pools = pools.filter(p => p.platform === platform);
    }
    if (minTvl) {
      pools = pools.filter(p => p.tvl >= minTvl);
    }

    pools = pools.slice(0, limit);

    res.json({
      success: true,
      lastUpdated,
      data: pools
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/pools/:poolId', async (req, res) => {
  try {
    const { poolId } = req.params;
    const pool = cachedPools.find(p => p.pool_id === poolId);
    if (!pool) {
      return res.status(404).json({ success: false, error: 'Pool not found' });
    }
    res.json({ success: true, data: pool });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/metrics', async (req, res) => {
  try {
    const pools = cachedPools;
    const totalPools = pools.length;
    const averageHealthScore = totalPools
      ? pools.reduce((sum, p) => sum + p.health_score, 0) / totalPools
      : 0;
    const totalTvl = pools.reduce((sum, p) => sum + p.tvl, 0);
    const highRiskPools = pools.filter(p => p.health_score < 50).length;
    const totalVolume24h = pools.reduce((sum, p) => sum + p.volume_24h, 0);

    res.json({
      success: true,
      data: {
        totalPools,
        averageHealthScore,
        totalTvl,
        highRiskPools,
        totalVolume24h
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    console.log('Manual refresh triggered (POST)...');
    const pools = await processPoolData();
    res.json({
      success: true,
      message: `Refreshed ${pools.length} pools (manual POST)`,
      data: pools.slice(0, 5)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  try {
    console.log('Manual refresh triggered (GET)...');
    const pools = await processPoolData();
    res.json({
      success: true,
      message: `Refreshed ${pools.length} pools (manual GET)`,
      data: pools.slice(0, 5)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Scheduled data update every hour ---
cron.schedule('0 * * * *', async () => {
  console.log('Running scheduled data update...');
  await processPoolData();
});

// --- Initial data load on startup ---
setTimeout(async () => {
  console.log('Loading initial data...');
  await processPoolData();
}, 5000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 DeFi Pool Analyzer API (DefiLlama, 1y chart, robust throttling/rotation) running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});
