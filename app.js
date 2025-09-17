// app.js - DeFi Pool Analyzer Backend (DefiLlama version for Uniswap V3 mainnet pools)
// Author: Pumis (and Copilot)
// Requirements: Node.js, express, axios, cors, node-cron, dotenv

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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

async function fetchDefiLlamaUniswapV3Pools() {
  try {
    console.log('Fetching Uniswap V3 pools from DefiLlama API...');
    const response = await axios.get(DEFI_LLAMA_POOLS_URL, { timeout: 25000 });
    // Filter to Uniswap V3 on Ethereum (mainnet)
    const allPools = response.data.data;
    const uniswapPools = allPools.filter(pool =>
      pool.project === "uniswap-v3" && pool.chain === "Ethereum"
    );
    console.log(`Success! Got ${uniswapPools.length} Uniswap V3 mainnet pools from DefiLlama`);
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
    const response = await axios.get(url, { timeout: 15000 });
    return response.data.data || {};
  } catch (error) {
    console.error(`Error fetching chart data for pool ${poolId}:`, error.message);
    return {};
  }
}

// --- Pool data processing (no database needed for demo; all in memory) ---
let cachedPools = [];
let lastUpdated = null;

async function processPoolData() {
  try {
    console.log('Starting data processing...');
    const uniswapPools = await fetchDefiLlamaUniswapV3Pools();

    if (!Array.isArray(uniswapPools) || uniswapPools.length === 0) {
      console.error('No pools returned. Skipping processing.');
      return [];
    }

    // Limit to 10 pools for demo and performance
    const poolsToProcess = uniswapPools.slice(0, 10);

    const processedPools = [];
    for (const pool of poolsToProcess) {
      try {
        // Get chart data (historical TVL, APR, volume, fees, dates) for each pool
        const chart = await fetchDefiLlamaPoolChart(pool.pool);

        // Prepare historical arrays, up to 90 days if available
        const maxHistory = 90;
        const tvlHistory = chart.tvl ? chart.tvl.slice(-maxHistory) : [];
        const aprHistory = chart.apy ? chart.apy.slice(-maxHistory) : [];
        const volumeHistory = chart.volume ? chart.volume.slice(-maxHistory) : [];
        const feesHistory = chart.fees ? chart.fees.slice(-maxHistory) : [];
        const dates = chart.tvl ? chart.tvl.slice(-maxHistory).map(e =>
          new Date(e.date * 1000).toISOString().split('T')[0]
        ) : [];

        // Current TVL/volume/APR
        const tvl = pool.tvlUsd || (tvlHistory.length > 0 ? tvlHistory[tvlHistory.length - 1].totalLiquidityUSD : 0);
        const volume24h = pool.volumeUsd1d || (volumeHistory.length > 0 ? volumeHistory[volumeHistory.length - 1].volume : 0);

        // Calculate volatility (price change variance) and health score
        const tvlVals = tvlHistory.map(h => h.totalLiquidityUSD || h.tvl || 0);
        const aprVals = aprHistory.map(h => h.apy || h.apr || 0);

        const volatility = calculateVariance(tvlVals);

        const poolData = {
          tvl,
          volume24h,
          aprHistory: aprVals,
          tvlHistory: tvlVals,
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
            tvl: tvlVals,
            volume: volumeHistory.map(h => h.volume || 0),
            fees: feesHistory.map(h => h.fees || 0),
            apr: aprVals,
            dates: dates
          }
        };

        processedPools.push(processedPool);
      } catch (error) {
        console.error(`Error processing pool ${pool.pool}:`, error.message);
      }
    }

    cachedPools = processedPools;
    lastUpdated = new Date().toISOString();

    console.log(`Processed and cached ${processedPools.length} pools.`);
    return processedPools;
  } catch (error) {
    console.error('Error in processPoolData:', error);
    return [];
  }
}

// --- API routes ---

app.get('/', (req, res) => {
  res.json({
    message: '🏊‍♂️ DeFi Pool Health Analyzer API (DefiLlama version)',
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
    limit = limit ? parseInt(limit) : 10;

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
  console.log(`🚀 DeFi Pool Analyzer API (DefiLlama) running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});
