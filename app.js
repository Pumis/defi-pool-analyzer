// app.js - DeFi Pool Analyzer Backend (updated for true Uniswap V3 mainnet subgraph and improved error handling)
// Author: Pumis (and Copilot)
// Requirements: Node.js, express, axios, cors, node-cron, dotenv (and optionally @supabase/supabase-js if using Supabase)

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

// --- Uniswap V3 subgraph: true mainnet endpoint, fetch 10 pools, 90 days per pool ---
async function fetchUniswapPools() {
  try {
    console.log('Fetching Uniswap pools from official public endpoint...');
    const query = `
      {
        pools(first: 10, orderBy: totalValueLockedUSD, orderDirection: desc, where: {totalValueLockedUSD_gt: "10000"}) {
          id
          token0 { symbol name id }
          token1 { symbol name id }
          totalValueLockedUSD
          volumeUSD
          feeTier
          poolDayData(first: 90, orderBy: date, orderDirection: desc) {
            date
            tvlUSD
            volumeUSD
            feesUSD
          }
        }
      }
    `;
    const endpoint = 'https://gateway.thegraph.com/api/192fc0f16279da99ab2ccde25879abca/subgraphs/id/QmVfG9N5K5y6KJ1WjQm9XjZzZjED3ko8bG9oAM1zXc5VCT';
    const response = await axios.post(endpoint, { query }, {
      timeout: 25000,
      headers: { 'Content-Type': 'application/json' }
      console.log('Raw response from The Graph:', JSON.stringify(response.data, null, 2));
    });

    if (response.data?.data?.pools && response.data.data.pools.length > 0) {
      console.log(`Success! Got ${response.data.data.pools.length} pools from Uniswap V3`);
      return response.data.data.pools;
    } else if (response.data?.errors) {
      console.log('API returned errors:', response.data.errors);
      return [];
    }
    return [];
  } catch (error) {
    console.error('Error fetching Uniswap data:', error.message);
    return [];
  }
}

// --- Pool data processing (no database needed for demo; all in memory) ---
let cachedPools = [];
let lastUpdated = null;

async function processPoolData() {
  try {
    console.log('Starting data processing...');
    const uniswapPools = await fetchUniswapPools();

    if (!Array.isArray(uniswapPools) || uniswapPools.length === 0) {
      console.error('No pools returned. Skipping processing.');
      return [];
    }

    const processedPools = [];

    for (const pool of uniswapPools) {
      try {
        const tokenPair = `${pool.token0.symbol}/${pool.token1.symbol}`;
        const tvl = parseFloat(pool.totalValueLockedUSD);
        const volume24h = parseFloat(pool.volumeUSD);

        // Extract historical data (reversed for chronological order)
        const tvlHistory = pool.poolDayData.map(day => parseFloat(day.tvlUSD)).reverse();
        const volumeHistory = pool.poolDayData.map(day => parseFloat(day.volumeUSD)).reverse();
        const feesHistory = pool.poolDayData.map(day => parseFloat(day.feesUSD)).reverse();

        // Calculate APR history (fees / TVL * 365)
        const aprHistory = pool.poolDayData.map(day => {
          const dailyFees = parseFloat(day.feesUSD);
          const dailyTvl = parseFloat(day.tvlUSD);
          return dailyTvl > 0 ? (dailyFees / dailyTvl) * 365 * 100 : 0;
        }).reverse();

        // Calculate volatility (price change variance)
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
          pool_id: pool.id,
          platform: 'uniswap-v3',
          token_pair: tokenPair,
          token0_symbol: pool.token0.symbol,
          token1_symbol: pool.token1.symbol,
          tvl: tvl,
          volume_24h: volume24h,
          fee_tier: parseFloat(pool.feeTier) / 10000, // Convert to percentage
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
            dates: pool.poolDayData.map(day => {
              // TheGraph returns days as unix-timestamp-in-seconds
              const timestamp = parseInt(day.date);
              return new Date(timestamp * 1000).toISOString().split('T')[0];
            }).reverse()
          }
        };

        processedPools.push(processedPool);
      } catch (error) {
        console.error(`Error processing pool ${pool.id}:`, error.message);
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
    message: '🏊‍♂️ DeFi Pool Health Analyzer API',
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
  console.log(`🚀 DeFi Pool Analyzer API running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});







