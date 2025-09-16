// app.js - DeFi Pool Analyzer Backend
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(cors());
app.use(express.json());

// Base route
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

// ---------------- Health Score Logic ----------------
function calculateVariance(values) {
  if (!values || values.length < 2) return 0;
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  return Math.sqrt(variance) / mean; // coefficient of variation
}

function calculateHealthScore(poolData) {
  const { tvl, volume24h, aprHistory, tvlHistory, volatility } = poolData;

  const tvlVariance = calculateVariance(tvlHistory);
  const tvlStability = Math.max(0, 25 - tvlVariance * 100);

  const aprVariance = calculateVariance(aprHistory);
  const aprConsistency = Math.max(0, 25 - aprVariance * 50);

  const volumeToTvlRatio = volume24h / tvl;
  const volumeEfficiency = Math.min(25, volumeToTvlRatio * 100);

  const ilRisk = Math.max(0, 25 - volatility * 50);

  const totalScore = tvlStability + aprConsistency + volumeEfficiency + ilRisk;

  return {
    totalScore: Math.min(100, Math.max(0, totalScore)),
    breakdown: { tvlStability, aprConsistency, volumeEfficiency, ilRisk }
  };
}

// ---------------- Mock Data ----------------
function generateMockDayData(days = 30) {
  const dayData = [];
  const baseDate = Date.now();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(baseDate - i * 24 * 60 * 60 * 1000);
    const timestamp = Math.floor(date.getTime() / 1000);
    const baseTvl = Math.random() * 50000000 + 1000000;
    const baseVolume = Math.random() * 5000000 + 100000;
    const baseFees = baseVolume * 0.003;

    dayData.push({
      date: timestamp.toString(),
      tvlUSD: (baseTvl * (0.8 + Math.random() * 0.4)).toFixed(2),
      volumeUSD: (baseVolume * (0.5 + Math.random())).toFixed(2),
      feesUSD: (baseFees * (0.5 + Math.random())).toFixed(2)
    });
  }

  return dayData;
}

function generateMockUniswapPools() {
  return [
    {
      id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      token0: { symbol: 'USDC', name: 'USD Coin', id: '0xa0b86a33e6d8f8' },
      token1: { symbol: 'WETH', name: 'Wrapped Ether', id: '0xc02aaa39b223' },
      totalValueLockedUSD: '156789012.34',
      volumeUSD: '12456789.12',
      feeTier: '500',
      poolDayData: generateMockDayData()
    },
    // ... Add more mock pools if needed
  ];
}

// ---------------- Data Fetching ----------------
async function fetchUniswapPools(days = 30) {
  const query = `
    {
      pools(first: 50, orderBy: totalValueLockedUSD, orderDirection: desc, where: {totalValueLockedUSD_gt: "10000"}) {
        id
        token0 { symbol name id }
        token1 { symbol name id }
        totalValueLockedUSD
        volumeUSD
        feeTier
        poolDayData(first: ${days}, orderBy: date, orderDirection: desc) {
          date
          tvlUSD
          volumeUSD
          feesUSD
        }
      }
    }
  `;

  const endpoints = [
    'https://api.thegraph.com/subgraphs/id/5zvR82QoaXuFyDwA2Zb3h6Jp1jHzRjHD6YHqKxjXGKNx'
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await axios.post(endpoint, { query }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
      if (response.data?.data?.pools && response.data.data.pools.length > 0) {
        return response.data.data.pools;
      }
    } catch (err) {
      console.log(`Endpoint failed: ${endpoint} | ${err.message}`);
    }
  }

  console.log('Falling back to mock data');
  return generateMockUniswapPools();
}

// ---------------- Processing ----------------
async function processPoolData() {
  try {
    const uniswapPools = await fetchUniswapPools();
    const processedPools = [];

    for (const pool of uniswapPools) {
      const tokenPair = `${pool.token0.symbol}/${pool.token1.symbol}`;
      const tvl = parseFloat(pool.totalValueLockedUSD);
      const volume24h = parseFloat(pool.volumeUSD);
      const tvlHistory = pool.poolDayData.map(d => parseFloat(d.tvlUSD)).reverse();
      const volumeHistory = pool.poolDayData.map(d => parseFloat(d.volumeUSD)).reverse();
      const feesHistory = pool.poolDayData.map(d => parseFloat(d.feesUSD)).reverse();

      const aprHistory = pool.poolDayData.map(day => {
        const dailyTvl = parseFloat(day.tvlUSD);
        const dailyFees = parseFloat(day.feesUSD);
        return dailyTvl > 0 ? (dailyFees / dailyTvl) * 365 * 100 : 0;
      }).reverse();

      const volatility = calculateVariance(tvlHistory);

      const healthScore = calculateHealthScore({ tvl, volume24h, aprHistory, tvlHistory, volatility });

      processedPools.push({
        pool_id: pool.id,
        platform: 'uniswap-v3',
        token_pair: tokenPair,
        token0_symbol: pool.token0.symbol,
        token1_symbol: pool.token1.symbol,
        tvl,
        volume_24h: volume24h,
        fee_tier: parseFloat(pool.feeTier) / 10000,
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
          dates: pool.poolDayData.map(day => new Date(parseInt(day.date) * 1000).toISOString().split('T')[0]).reverse()
        }
      });
    }

    if (processedPools.length > 0) {
      const { error } = await supabase.from('pools').upsert(processedPools, { onConflict: 'pool_id' });
      if (error) console.error('Supabase upsert error:', error);
    }

    return processedPools;
  } catch (err) {
    console.error('Error in processPoolData:', err.message);
    return [];
  }
}

// ---------------- API Routes ----------------
app.get('/api/pools', async (req, res) => {
  try {
    const { platform = 'uniswap-v3', minTvl, days = 30, limit = 50 } = req.query;

    let pools = [];
    if (platform === 'uniswap-v3') pools = await fetchUniswapPools(parseInt(days));

    if (minTvl) pools = pools.filter(p => parseFloat(p.totalValueLockedUSD) >= parseFloat(minTvl));

    res.json({ success: true, data: pools.slice(0, parseInt(limit)), count: pools.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/metrics', async (req, res) => {
  try {
    const { data: pools, error } = await supabase.from('pools').select('health_score, tvl, volume_24h');
    if (error) throw error;

    const metrics = {
      totalPools: pools.length,
      averageHealthScore: pools.length ? pools.reduce((sum, p) => sum + p.health_score, 0) / pools.length : 0,
      totalTvl: pools.reduce((sum, p) => sum + p.tvl, 0),
      highRiskPools: pools.filter(p => p.health_score < 50).length,
      totalVolume24h: pools.reduce((sum, p) => sum + p.volume_24h, 0)
    };

    res.json({ success: true, data: metrics });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const pools = await processPoolData();
    res.json({ success: true, message: `Refreshed ${pools.length} pools`, data: pools.slice(0, 10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'DeFi Pool Analyzer API is running', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ---------------- Cron Job ----------------
cron.schedule('0 * * * *', async () => {
  console.log('Running scheduled data update...');
  await processPoolData();
});

// ---------------- Initial Load ----------------
setTimeout(async () => {
  console.log('Loading initial data...');
  await processPoolData();
}, 5000);

// ---------------- Start Server ----------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 DeFi Pool Analyzer API running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});
