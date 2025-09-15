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
    console.log('Fetching Uniswap pools...');
    const query = `
      {
        pools(first: 50, orderBy: totalValueLockedUSD, orderDirection: desc) {
          id
          token0 {
            symbol
            name
          }
          token1 {
            symbol
            name
          }
          totalValueLockedUSD
          volumeUSD
          feeTier
          poolDayData(first: 30, orderBy: date, orderDirection: desc) {
            date
            tvlUSD
            volumeUSD
            feesUSD
          }
        }
      }
    `;

    const response = await axios.post('https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3', {
      query
    });

    return response.data?.data?.pools || [];
  } catch (error) {
    console.error('Error fetching Uniswap data:', error.message);
    return [];
  }
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
        
        // Extract historical data
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
            dates: pool.poolDayData.map(day => day.date).reverse()
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

// API Routes
app.get('/api/pools', async (req, res) => {
  try {
    const { platform, minTvl, limit = 50 } = req.query;
    
    let query = supabase
      .from('pools')
      .select('*')
      .order('health_score', { ascending: false })
      .limit(parseInt(limit));

    if (platform && platform !== 'all') {
      query = query.eq('platform', platform);
    }

    if (minTvl) {
      query = query.gte('tvl', parseFloat(minTvl));
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data: data || [],
      count: data?.length || 0
    });
  } catch (error) {
    console.error('Error fetching pools:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/pools/:poolId', async (req, res) => {
  try {
    const { poolId } = req.params;
    
    const { data, error } = await supabase
      .from('pools')
      .select('*')
      .eq('pool_id', poolId)
      .single();

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data: data
    });
  } catch (error) {
    console.error('Error fetching pool:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/metrics', async (req, res) => {
  try {
    const { data: pools, error } = await supabase
      .from('pools')
      .select('health_score, tvl, volume_24h');

    if (error) {
      throw error;
    }

    const metrics = {
      totalPools: pools.length,
      averageHealthScore: pools.length > 0 
        ? pools.reduce((sum, p) => sum + p.health_score, 0) / pools.length 
        : 0,
      totalTvl: pools.reduce((sum, p) => sum + p.tvl, 0),
      highRiskPools: pools.filter(p => p.health_score < 50).length,
      totalVolume24h: pools.reduce((sum, p) => sum + p.volume_24h, 0)
    };

    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    console.error('Error fetching metrics:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    console.log('Manual refresh triggered...');
    const pools = await processPoolData();
    
    res.json({
      success: true,
      message: `Refreshed ${pools.length} pools`,
      data: pools.slice(0, 10) // Return first 10 pools
    });
  } catch (error) {
    console.error('Error refreshing data:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'DeFi Pool Analyzer API is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
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

app.listen(PORT, () => {
  console.log(`🚀 DeFi Pool Analyzer API running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});