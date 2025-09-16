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
    console.log('Fetching Uniswap pools from new endpoint...');
    
    // Use the new decentralized endpoint
    const query = `
      {
        pools(first: 50, orderBy: totalValueLockedUSD, orderDirection: desc, where: {totalValueLockedUSD_gt: "10000"}) {
          id
          token0 {
            symbol
            name
            id
          }
          token1 {
            symbol
            name
            id
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

    // Try multiple endpoints - The Graph has moved to decentralized hosting
    const endpoints = [
      'https://gateway-arbitrum.network.thegraph.com/api/[api-key]/subgraphs/id/5zvR82QoaXuFyDwA2Zb3h6Jp1jHzRjHD6YHqKxjXGKNx',
      'https://api.studio.thegraph.com/query/63859/uniswap-v3-mainnet/version/latest',
      'https://api.thegraph.com/subgraphs/id/5zvR82QoaXuFyDwA2Zb3h6Jp1jHzRjHD6YHqKxjXGKNx'
    ];

    let pools = [];
    
    for (const endpoint of endpoints) {
      try {
        console.log(`Trying endpoint: ${endpoint}`);
        
        const response = await axios.post(endpoint, { query }, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json'
          }
        });

        console.log('Response status:', response.status);
        console.log('Response data:', JSON.stringify(response.data, null, 2));

        if (response.data?.data?.pools && response.data.data.pools.length > 0) {
          pools = response.data.data.pools;
          console.log(`Success! Got ${pools.length} pools from ${endpoint}`);
          break;
        } else if (response.data?.errors) {
          console.log('API returned errors:', response.data.errors);
        }
      } catch (endpointError) {
        console.log(`Endpoint ${endpoint} failed:`, endpointError.message);
        continue;
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

// Add mock data generator
function generateMockUniswapPools() {
  console.log('Generating mock Uniswap pools...');
  
  const mockPools = [
    {
      id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      token0: { symbol: 'USDC', name: 'USD Coin', id: '0xa0b86a33e6d8f8' },
      token1: { symbol: 'WETH', name: 'Wrapped Ether', id: '0xc02aaa39b223' },
      totalValueLockedUSD: '156789012.34',
      volumeUSD: '12456789.12',
      feeTier: '500',
      poolDayData: generateMockDayData()
    },
    {
      id: '0xcbcdf9626bc03e24f779434178a73a0b4bad62ed',
      token0: { symbol: 'WBTC', name: 'Wrapped Bitcoin', id: '0x2260fac5e5542' },
      token1: { symbol: 'WETH', name: 'Wrapped Ether', id: '0xc02aaa39b223' },
      totalValueLockedUSD: '87654321.98',
      volumeUSD: '5432109.87',
      feeTier: '3000',
      poolDayData: generateMockDayData()
    },
    {
      id: '0x3416cf6c708da44db2624d63ea0aaef7113527c6',
      token0: { symbol: 'USDC', name: 'USD Coin', id: '0xa0b86a33e6d8f8' },
      token1: { symbol: 'USDT', name: 'Tether USD', id: '0xdac17f958d2ee5' },
      totalValueLockedUSD: '234567890.12',
      volumeUSD: '18765432.10',
      feeTier: '100',
      poolDayData: generateMockDayData()
    },
    {
      id: '0xa374094527e1673a86de625aa59517c5de346d32',
      token0: { symbol: 'UNI', name: 'Uniswap', id: '0x1f9840a85d5af5' },
      token1: { symbol: 'WETH', name: 'Wrapped Ether', id: '0xc02aaa39b223' },
      totalValueLockedUSD: '45678901.23',
      volumeUSD: '3456789.01',
      feeTier: '3000',
      poolDayData: generateMockDayData()
    },
    {
      id: '0x1d42064fc4beb5f8aaf85f4617ae5b3b5b37d613',
      token0: { symbol: 'LINK', name: 'Chainlink', id: '0x514910771af9ca' },
      token1: { symbol: 'WETH', name: 'Wrapped Ether', id: '0xc02aaa39b223' },
      totalValueLockedUSD: '32109876.54',
      volumeUSD: '2109876.54',
      feeTier: '3000',
      poolDayData: generateMockDayData()
    },
    {
      id: '0x5777d92f208679db4b9778590fa3cab3ac9e2168',
      token0: { symbol: 'AAVE', name: 'Aave', id: '0x7fc66500c84a76ad' },
      token1: { symbol: 'WETH', name: 'Wrapped Ether', id: '0xc02aaa39b223' },
      totalValueLockedUSD: '21098765.43',
      volumeUSD: '1543210.98',
      feeTier: '3000',
      poolDayData: generateMockDayData()
    },
    {
      id: '0x290a6a7460b308ee3f19023d2d00de604bcf5b42',
      token0: { symbol: 'MATIC', name: 'Polygon', id: '0x7d1afa7b718fb893' },
      token1: { symbol: 'WETH', name: 'Wrapped Ether', id: '0xc02aaa39b223' },
      totalValueLockedUSD: '18765432.10',
      volumeUSD: '1234567.89',
      feeTier: '3000',
      poolDayData: generateMockDayData()
    },
    {
      id: '0x60594a405d53811d3bc4766596efd80fd545a270',
      token0: { symbol: 'DAI', name: 'Dai Stablecoin', id: '0x6b175474e89094c4' },
      token1: { symbol: 'WETH', name: 'Wrapped Ether', id: '0xc02aaa39b223' },
      totalValueLockedUSD: '76543210.98',
      volumeUSD: '6543210.98',
      feeTier: '3000',
      poolDayData: generateMockDayData()
    },
    {
      id: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      token0: { symbol: 'WETH', name: 'Wrapped Ether', id: '0xc02aaa39b223' },
      token1: { symbol: 'USDT', name: 'Tether USD', id: '0xdac17f958d2ee5' },
      totalValueLockedUSD: '98765432.10',
      volumeUSD: '8765432.10',
      feeTier: '3000',
      poolDayData: generateMockDayData()
    },
    {
      id: '0x11b815efb8f581194ae79006d24e0d814b7697f6',
      token0: { symbol: 'WETH', name: 'Wrapped Ether', id: '0xc02aaa39b223' },
      token1: { symbol: 'USDT', name: 'Tether USD', id: '0xdac17f958d2ee5' },
      totalValueLockedUSD: '54321098.76',
      volumeUSD: '4321098.76',
      feeTier: '500',
      poolDayData: generateMockDayData()
    },
    {
      id: '0x3416cf6c708da44db2624d63ea0aaef7113527c7',
      token0: { symbol: 'CRV', name: 'Curve DAO Token', id: '0xd533a949740bb3306' },
      token1: { symbol: 'WETH', name: 'Wrapped Ether', id: '0xc02aaa39b223' },
      totalValueLockedUSD: '29876543.21',
      volumeUSD: '1876543.21',
      feeTier: '3000',
      poolDayData: generateMockDayData()
    },
    {
      id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5641',
      token0: { symbol: 'COMP', name: 'Compound', id: '0xc00e94cb662c3520' },
      token1: { symbol: 'WETH', name: 'Wrapped Ether', id: '0xc02aaa39b223' },
      totalValueLockedUSD: '19876543.21',
      volumeUSD: '987654.32',
      feeTier: '3000',
      poolDayData: generateMockDayData()
    }
  ];

  console.log(`Generated ${mockPools.length} mock pools`);
  return mockPools;
}

function generateMockDayData() {
  const dayData = [];
  const baseDate = Date.now();
  
  for (let i = 29; i >= 0; i--) {
    const date = new Date(baseDate - (i * 24 * 60 * 60 * 1000));
    const dateString = Math.floor(date.getTime() / 1000).toString();
    
    const baseTvl = Math.random() * 50000000 + 1000000;
    const baseVolume = Math.random() * 5000000 + 100000;
    const baseFees = baseVolume * 0.003;
    
    dayData.push({
      date: dateString,
      tvlUSD: (baseTvl * (0.8 + Math.random() * 0.4)).toFixed(2),
      volumeUSD: (baseVolume * (0.5 + Math.random())).toFixed(2),
      feesUSD: (baseFees * (0.5 + Math.random())).toFixed(2)
    });
  }
  
  return dayData;
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

app.get('/api/pools', async (req, res) => {
  try {
    const { platform = 'uniswap-v3', days = 30, limit = 50 } = req.query;

    let pools = [];
    
    if (platform === 'uniswap-v3') {
      pools = await fetchUniswapPools(parseInt(days));
    }
    // Optional: handle other protocols like Curve, Balancer here

    res.json({
      success: true,
      data: pools.slice(0, parseInt(limit)),
      count: pools.length
    });
  } catch (error) {
    console.error('Error fetching pools:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

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
  // ...rest of your code unchanged
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


