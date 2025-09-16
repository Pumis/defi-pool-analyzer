// server.js - Complete DeFi Pool Analyzer Backend
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

// Add this route for the base URL
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

// Health scoring algorithm
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

// Data fetching functions
async function fetchDefiLlamaData() {
  try {
    console.log('Fetching DeFiLlama data...');
    const response = await axios.get('https://api.llama.fi/protocols');
    return response.data;
  } catch (error) {
    console.error('Error fetching DeFiLlama data:', error.message);
    return [];
  }
}

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
    const endpoint = 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3';
    const response = await axios.post(endpoint, { query }, {
      timeout: 25000,
      headers: { 'Content-Type': 'application/json' }
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

    if (pools.length === 0) {
      console.log('All endpoints failed, generating mock data...');
      return generateMockUniswapPools();
    }

    return pools;
  } catch (error) {
    console.error('Error fetching Uniswap data:', error.message);
    console.log('Falling back to mock data...');
    return generateMockUniswapPools();
  }
}

// Add mock data generator (unchanged, but not used if real data is returned)
function generateMockUniswapPools() {
  // ... unchanged ...
}

function generateMockDayData() {
  // ... unchanged ...
}

async function fetchTokenPrices(tokenIds) {
  try {
    const ids = tokenIds.join(',');
    const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
    return response.data;
  } catch (error) {
    console.error('Error fetching token prices:', error.message);
    return {};
  }
}

// Process and store pool data
async function processPoolData() {
  try {
    console.log('Starting data processing...');
    
    const uniswapPools = await fetchUniswapPools();
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

    // Store in Supabase
    if (processedPools.length > 0) {
      const { data, error } = await supabase
        .from('pools')
        .upsert(processedPools, { onConflict: 'pool_id' });

      if (error) {
        console.error('Error storing pools:', error);
      } else {
        console.log(`Successfully stored ${processedPools.length} pools`);
      }
    }

    return processedPools;
  } catch (error) {
    console.error('Error in processPoolData:', error);
    return [];
  }
}

// API Routes (unchanged from your original)
app.get('/api/pools', async (req, res) => {
  // ... unchanged ...
});

app.get('/api/pools/:poolId', async (req, res) => {
  // ... unchanged ...
});

app.get('/api/metrics', async (req, res) => {
  // ... unchanged ...
});

app.post('/api/refresh', async (req, res) => {
  // ... unchanged ...
});

app.get('/api/health', (req, res) => {
  // ... unchanged ...
});

// Schedule data updates every hour
cron.schedule('0 * * * *', async () => {
  console.log('Running scheduled data update...');
  await processPoolData();
});

// Initial data load on startup
setTimeout(async () => {
  console.log('Loading initial data...');
  await processPoolData();
}, 5000);

app.get('/api/refresh', async (req, res) => {
  console.log('Manual refresh triggered (GET)...');
  const pools = await processPoolData();
  res.json({
    success: true,
    message: `Refreshed ${pools.length} pools (via GET)`,
    data: pools.slice(0, 10)
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 DeFi Pool Analyzer API running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});

