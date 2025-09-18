// app.js - DeFi Pool Analyzer Backend (Fixed & Enhanced)
// Author: Pumis (Enhanced with AI improvements)
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

// Enhanced Health scoring algorithm - FIXED
function calculateHealthScore(poolData) {
  const { tvl, volume24h, aprHistory, tvlHistory, volatility } = poolData;
  
  // TVL Stability (0-25 points) - exponential decay for better scaling
  const tvlVariance = calculateVariance(tvlHistory);
  const tvlStability = Math.max(0, Math.min(25, 25 * Math.exp(-tvlVariance * 2)));
  
  // APR Consistency (0-25 points) - exponential decay
  const aprVariance = calculateVariance(aprHistory);
  const aprConsistency = Math.max(0, Math.min(25, 25 * Math.exp(-aprVariance * 0.5)));
  
  // Volume Efficiency (0-25 points) - better normalization
  const volumeToTvlRatio = volume24h / Math.max(tvl, 1);
  const volumeEfficiency = Math.min(25, Math.max(0, volumeToTvlRatio * 2500));
  
  // Liquidity Depth (0-25 points) - reward higher TVL with logarithmic scaling
  const liquidityScore = Math.min(25, Math.max(0, (Math.log(Math.max(tvl, 1000)) - 6.9) * 3.6));
  
  const totalScore = tvlStability + aprConsistency + volumeEfficiency + liquidityScore;
  
  return {
    totalScore: Math.min(100, Math.max(0, totalScore)),
    breakdown: { 
      tvlStability: Math.round(tvlStability * 100) / 100,
      aprConsistency: Math.round(aprConsistency * 100) / 100,
      volumeEfficiency: Math.round(volumeEfficiency * 100) / 100,
      liquidityScore: Math.round(liquidityScore * 100) / 100
    }
  };
}

function calculateVariance(values) {
  if (!values || values.length < 2) return 0;
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

// Risk category helper
function getRiskCategory(healthScore) {
  if (healthScore >= 80) return { label: 'Conservative', color: '#27ae60', description: 'Low risk, stable pools' };
  if (healthScore >= 60) return { label: 'Moderate', color: '#f39c12', description: 'Medium risk, balanced pools' };
  if (healthScore >= 40) return { label: 'Aggressive', color: '#e67e22', description: 'High risk, higher potential returns' };
  return { label: 'Speculative', color: '#e74c3c', description: 'Very high risk, experimental pools' };
}

// Pool quality filtering
function isQualityPool(pool) {
  // Skip pools with very low TVL
  if (pool.tvlUsd < 10000) return false;
  
  // Skip pools without proper symbol format
  if (!pool.symbol || !pool.symbol.includes('-')) return false;
  
  // Prioritize pools with major tokens
  const majorTokens = ['WETH', 'USDC', 'USDT', 'DAI', 'WBTC', 'UNI', 'LINK', 'AAVE'];
  const tokens = pool.symbol.split('-');
  const hasMajorToken = tokens.some(token => majorTokens.includes(token));
  
  // Allow high TVL pools even without major tokens
  if (pool.tvlUsd > 100000 || hasMajorToken) return true;
  
  return false;
}

// DefiLlama integration
const DEFI_LLAMA_POOLS_URL = "https://yields.llama.fi/pools";
const DEFI_LLAMA_POOL_CHART_URL = "https://yields.llama.fi/chart/";

async function fetchDefiLlamaUniswapV3Pools() {
  try {
    if (fs.existsSync(POOLS_CACHE_FILE)) {
      const cached = JSON.parse(fs.readFileSync(POOLS_CACHE_FILE, 'utf8'));
      if (cached && Array.isArray(cached) && cached.length > 0) {
        console.log(`Loaded ${cached.length} Uniswap V3 mainnet pools from local cache`);
        return cached;
      }
    }
    
    console.log('Fetching Uniswap V3 pools from DefiLlama API...');
    const response = await axios.get(DEFI_LLAMA_POOLS_URL, { timeout: 25000 });
    const allPools = response.data.data;
    
    // Enhanced filtering for quality pools
    const uniswapPools = allPools
      .filter(pool => pool.project === "uniswap-v3" && pool.chain === "Ethereum")
      .filter(isQualityPool)
      .sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0)); // Sort by TVL descending
    
    console.log(`Found ${uniswapPools.length} quality Uniswap V3 mainnet pools from DefiLlama`);
    fs.writeFileSync(POOLS_CACHE_FILE, JSON.stringify(uniswapPools, null, 2));
    return uniswapPools;
  } catch (error) {
    console.error('Error fetching DefiLlama pool data:', error.message);
    return [];
  }
}

async function fetchDefiLlamaPoolChart(poolId) {
  try {
    const url = DEFI_LLAMA_POOL_CHART_URL + encodeURIComponent(poolId);
    const response = await axios.get(url, { timeout: 20000 });
    
    if (response.data && Array.isArray(response.data.data)) {
      const daily = response.data.data;
      const result = {
        tvl: daily.map(d => ({ date: new Date(d.timestamp).getTime() / 1000, tvl: d.tvlUsd })),
        apy: daily.map(d => ({ date: new Date(d.timestamp).getTime() / 1000, apy: d.apy })),
        volume: daily.map(d => ({ date: new Date(d.timestamp).getTime() / 1000, volume: d.volumeUsd || 0 })),
        fees: daily.map(d => ({ date: new Date(d.timestamp).getTime() / 1000, fees: d.feesUsd || 0 }))
      };
      return result;
    } else {
      console.warn(`No chart data for pool ${poolId}`);
      return {};
    }
  } catch (error) {
    if (error.response && error.response.status === 429) {
      console.warn(`Rate limited on pool ${poolId}. Waiting 3 seconds and retrying...`);
      await delay(3000);
      return fetchDefiLlamaPoolChart(poolId);
    }
    console.error(`Error fetching chart data for pool ${poolId}:`, error.message);
    return {};
  }
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// Pool data processing
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
    
    const processedPools = [];
    let checked = 0;
    let added = 0;
    const POOLS_PER_REFRESH = 15; // Reduced for better quality
    const DELAY_BETWEEN_REQUESTS = 2000; // Increased delay
    const maxHistory = 365;
    
    let lastIndex = readLastProcessedIndex();
    if (lastIndex >= uniswapPools.length) lastIndex = 0;
    
    for (let i = 0; i < POOLS_PER_REFRESH; i++) {
      const poolIdx = (lastIndex + i) % uniswapPools.length;
      const pool = uniswapPools[poolIdx];
      checked++;
      
      try {
        await delay(DELAY_BETWEEN_REQUESTS);
        const chart = await fetchDefiLlamaPoolChart(pool.pool);
        
        console.log(`Pool ${pool.pool} (${pool.symbol}) TVL: $${pool.tvlUsd?.toLocaleString()} Chart data: ${Array.isArray(chart.tvl) ? chart.tvl.length : 'N/A'} days`);
        
        if (!Array.isArray(chart.tvl) || chart.tvl.length < 7) {
          console.warn(`Insufficient chart data for pool ${pool.pool} (${pool.symbol}) - skipping`);
          continue;
        }
        
        const tvlHistory = chart.tvl.slice(-maxHistory).map(h => h.tvl || 0);
        const aprHistory = chart.apy.slice(-maxHistory).map(h => h.apy || 0);
        const volumeHistory = chart.volume.slice(-maxHistory).map(h => h.volume || 0);
        const feesHistory = chart.fees.slice(-maxHistory).map(h => h.fees || 0);
        const dates = chart.tvl.slice(-maxHistory).map(e => new Date(e.date * 1000).toISOString().split('T')[0]);
        
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
        const riskCategory = getRiskCategory(healthScore.totalScore);
        
        // Calculate additional metrics
        const avgApr = aprHistory.length > 0 ? aprHistory.reduce((sum, apr) => sum + apr, 0) / aprHistory.length : 0;
        const avgVolume = volumeHistory.length > 0 ? volumeHistory.reduce((sum, vol) => sum + vol, 0) / volumeHistory.length : 0;
        
        const processedPool = {
          pool_id: pool.pool,
          platform: 'uniswap-v3',
          token_pair: pool.symbol,
          token0_symbol: pool.symbol.split('-')[0],
          token1_symbol: pool.symbol.split('-')[1] || '',
          tvl,
          volume_24h: volume24h,
          avg_volume: avgVolume,
          fee_tier: pool.metadata && pool.metadata.fee ? pool.metadata.fee : null,
          health_score: Math.round(healthScore.totalScore * 100) / 100,
          tvl_stability: healthScore.breakdown.tvlStability,
          apr_consistency: healthScore.breakdown.aprConsistency,
          volume_efficiency: healthScore.breakdown.volumeEfficiency,
          liquidity_score: healthScore.breakdown.liquidityScore,
          risk_category: riskCategory,
          avg_apr: Math.round(avgApr * 100) / 100,
          data_points: tvlHistory.length,
          last_updated: new Date().toISOString(),
          historical_data: { 
            tvl: tvlHistory, 
            volume: volumeHistory, 
            fees: feesHistory, 
            apr: aprHistory, 
            dates 
          }
        };
        
        processedPools.push(processedPool);
        added++;
        
        console.log(`✓ Processed ${pool.symbol} - Health Score: ${processedPool.health_score} (${riskCategory.label})`);
        
      } catch (error) {
        console.error(`Error processing pool ${pool.pool}:`, error.message);
      }
    }
    
    writeLastProcessedIndex((lastIndex + POOLS_PER_REFRESH) % uniswapPools.length);
    
    // Merge with existing pools
    let mergedPools = Array.isArray(cachedPools) ? [...cachedPools] : [];
    for (const pool of processedPools) {
      const idx = mergedPools.findIndex(p => p.pool_id === pool.pool_id);
      if (idx >= 0) {
        mergedPools[idx] = pool;
      } else {
        mergedPools.push(pool);
      }
    }
    
    // Sort by health score descending
    mergedPools.sort((a, b) => b.health_score - a.health_score);
    
    cachedPools = mergedPools;
    lastUpdated = new Date().toISOString();
    
    console.log(`Processed ${checked} pools, added/updated ${added} pools. Total cached: ${cachedPools.length}`);
    console.log(`Health Score Distribution: ${cachedPools.filter(p => p.health_score >= 80).length} Conservative, ${cachedPools.filter(p => p.health_score >= 60 && p.health_score < 80).length} Moderate, ${cachedPools.filter(p => p.health_score >= 40 && p.health_score < 60).length} Aggressive, ${cachedPools.filter(p => p.health_score < 40).length} Speculative`);
    
    return processedPools;
  } catch (error) {
    console.error('Error in processPoolData:', error);
    return [];
  }
}

// Enhanced API routes
app.get('/', (req, res) => {
  res.json({
    message: 'DeFi Pool Health Analyzer API (Enhanced)',
    status: 'running',
    version: '2.0.0',
    totalPools: cachedPools.length,
    lastUpdated,
    endpoints: { 
      health: '/api/health', 
      pools: '/api/pools', 
      metrics: '/api/metrics', 
      refresh: '/api/refresh',
      trending: '/api/trending',
      top: '/api/top'
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  const healthStats = {
    status: 'ok',
    uptime: process.uptime(),
    lastUpdated,
    totalPools: cachedPools.length,
    memoryUsage: process.memoryUsage(),
    version: '2.0.0'
  };
  res.json(healthStats);
});

app.get('/api/pools', async (req, res) => {
  try {
    let { platform, minTvl, limit, sortBy, search, riskCategory } = req.query;
    minTvl = minTvl ? parseFloat(minTvl) : 0;
    limit = limit ? parseInt(limit) : 50;
    sortBy = sortBy || 'health_score';
    
    let pools = [...cachedPools];
    
    // Apply filters
    if (platform && platform !== 'all') {
      pools = pools.filter(p => p.platform === platform);
    }
    
    if (minTvl > 0) {
      pools = pools.filter(p => p.tvl >= minTvl);
    }
    
    if (search) {
      const searchLower = search.toLowerCase();
      pools = pools.filter(p => 
        p.token_pair.toLowerCase().includes(searchLower) ||
        p.token0_symbol.toLowerCase().includes(searchLower) ||
        p.token1_symbol.toLowerCase().includes(searchLower)
      );
    }
    
    if (riskCategory) {
      pools = pools.filter(p => p.risk_category.label.toLowerCase() === riskCategory.toLowerCase());
    }
    
    // Apply sorting
    pools.sort((a, b) => {
      switch (sortBy) {
        case 'tvl':
          return b.tvl - a.tvl;
        case 'volume':
          return b.volume_24h - a.volume_24h;
        case 'health_score':
        default:
          return b.health_score - a.health_score;
      }
    });
    
    // Apply pagination
    const totalCount = pools.length;
    pools = pools.slice(0, limit);
    
    res.json({ 
      success: true, 
      lastUpdated, 
      data: pools,
      pagination: {
        total: totalCount,
        limit: limit,
        showing: pools.length
      }
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
    
    const averageHealthScore = totalPools > 0 
      ? pools.reduce((sum, p) => sum + p.health_score, 0) / totalPools 
      : 0;
    
    const totalTvl = pools.reduce((sum, p) => sum + p.tvl, 0);
    const totalVolume24h = pools.reduce((sum, p) => sum + p.volume_24h, 0);
    
    // Risk distribution
    const conservative = pools.filter(p => p.health_score >= 80).length;
    const moderate = pools.filter(p => p.health_score >= 60 && p.health_score < 80).length;
    const aggressive = pools.filter(p => p.health_score >= 40 && p.health_score < 60).length;
    const speculative = pools.filter(p => p.health_score < 40).length;
    
    const metrics = {
      totalPools,
      averageHealthScore: Math.round(averageHealthScore * 100) / 100,
      totalTvl,
      totalVolume24h,
      riskDistribution: {
        conservative,
        moderate, 
        aggressive,
        speculative
      },
      topPerformers: pools.slice(0, 5).map(p => ({
        symbol: p.token_pair,
        healthScore: p.health_score,
        tvl: p.tvl,
        riskCategory: p.risk_category.label
      }))
    };
    
    res.json({ success: true, data: metrics });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// New endpoint for top performing pools
app.get('/api/top', async (req, res) => {
  try {
    const { category = 'health', limit = 10 } = req.query;
    let pools = [...cachedPools];
    
    switch (category) {
      case 'tvl':
        pools.sort((a, b) => b.tvl - a.tvl);
        break;
      case 'volume':
        pools.sort((a, b) => b.volume_24h - a.volume_24h);
        break;
      case 'conservative':
        pools = pools.filter(p => p.health_score >= 80).sort((a, b) => b.health_score - a.health_score);
        break;
      case 'health':
      default:
        pools.sort((a, b) => b.health_score - a.health_score);
    }
    
    res.json({
      success: true,
      category,
      data: pools.slice(0, parseInt(limit))
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
      message: `Refreshed ${pools.length} pools`, 
      totalCached: cachedPools.length,
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
      message: `Refreshed ${pools.length} pools`, 
      totalCached: cachedPools.length,
      data: pools.slice(0, 5) 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Scheduled updates - every 2 hours for better rate limiting
cron.schedule('0 */2 * * *', async () => {
  console.log('Running scheduled data update...');
  await processPoolData();
});

// Initial load with delay
setTimeout(async () => {
  console.log('Loading initial data...');
  await processPoolData();
}, 10000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DeFi Pool Health Analyzer API v2.0 running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Enhanced with improved scoring, filtering, and analytics`);
});
