// app.js - DeFi Pool Analyzer Backend (Enhanced with Recommendations)
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const POOLS_CACHE_FILE = './pools_cache.json';
const PROCESSED_INDEX_FILE = './last_processed_index.json';
const METRICS_CACHE_FILE = './metrics_cache.json';
const NEWS_CACHE_FILE = './news_cache.json';

app.use(cors());
app.use(express.json());

// Enhanced Health scoring algorithm with additional factors
function calculateHealthScore(poolData) {
  const { tvl, volume24h, aprHistory, tvlHistory, volatility, protocolRisk, governanceScore } = poolData;
  
  // Core metrics (80 points)
  const tvlVariance = calculateVariance(tvlHistory);
  const tvlStability = Math.max(0, Math.min(20, 20 * Math.exp(-tvlVariance * 2)));
  
  const aprVariance = calculateVariance(aprHistory);
  const aprConsistency = Math.max(0, Math.min(20, 20 * Math.exp(-aprVariance * 0.5)));
  
  const volumeToTvlRatio = volume24h / Math.max(tvl, 1);
  const volumeEfficiency = Math.min(20, Math.max(0, volumeToTvlRatio * 2000));
  
  const liquidityScore = Math.min(20, Math.max(0, (Math.log(Math.max(tvl, 1000)) - 6.9) * 2.9));
  
  // Enhanced factors (20 points)
  const protocolTrust = Math.min(10, Math.max(0, protocolRisk * 10)); // Protocol maturity
  const governanceFactor = Math.min(10, Math.max(0, governanceScore * 10)); // Governance quality
  
  const totalScore = tvlStability + aprConsistency + volumeEfficiency + liquidityScore + protocolTrust + governanceFactor;
  
  return {
    totalScore: Math.min(100, Math.max(0, totalScore)),
    breakdown: { 
      tvlStability: Math.round(tvlStability * 100) / 100,
      aprConsistency: Math.round(aprConsistency * 100) / 100,
      volumeEfficiency: Math.round(volumeEfficiency * 100) / 100,
      liquidityScore: Math.round(liquidityScore * 100) / 100,
      protocolTrust: Math.round(protocolTrust * 100) / 100,
      governanceFactor: Math.round(governanceFactor * 100) / 100
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

// Protocol risk assessment
function assessProtocolRisk(project) {
  const protocolRisk = {
    'uniswap-v3': 0.9, // Very established
    'sushiswap': 0.8,  // Established
    'balancer-v2': 0.7, // Moderate
    'curve': 0.85,     // Very established for stables
    'pancakeswap': 0.6, // Less established on mainnet
    'default': 0.5
  };
  return protocolRisk[project] || protocolRisk['default'];
}

// Governance scoring (simplified)
function calculateGovernanceScore(project, tvl) {
  const baseGovernance = {
    'uniswap-v3': 0.9,
    'sushiswap': 0.7,
    'balancer-v2': 0.8,
    'curve': 0.85,
    'default': 0.5
  };
  
  const base = baseGovernance[project] || baseGovernance['default'];
  const tvlBoost = Math.min(0.2, tvl / 100000000); // Up to 0.2 boost for high TVL
  return Math.min(1, base + tvlBoost);
}

// Pool quality filtering with enhanced criteria
function isQualityPool(pool) {
  if (pool.tvlUsd < 5000) return false; // Lowered minimum for more diversity
  if (!pool.symbol || !pool.symbol.includes('-')) return false;
  
  // Enhanced filtering
  const majorTokens = ['WETH', 'USDC', 'USDT', 'DAI', 'WBTC', 'UNI', 'LINK', 'AAVE', 'CRV', 'BAL', 'MATIC', 'OP', 'ARB'];
  const stablecoins = ['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD'];
  const tokens = pool.symbol.split('-');
  
  const hasMajorToken = tokens.some(token => majorTokens.includes(token));
  const hasStablecoin = tokens.some(token => stablecoins.includes(token));
  const isHighTvl = pool.tvlUsd > 50000;
  
  return isHighTvl || hasMajorToken || hasStablecoin;
}

// News and sentiment analysis (basic implementation)
async function fetchDefiNews() {
  try {
    // This would integrate with news APIs like CoinGecko, CryptoNews, etc.
    // For now, we'll create a placeholder that could be enhanced
    const newsData = {
      sentiment: 'neutral', // positive, negative, neutral
      relevantNews: [],
      marketTrend: 'stable'
    };
    
    // Cache news for 1 hour
    fs.writeFileSync(NEWS_CACHE_FILE, JSON.stringify({
      data: newsData,
      timestamp: Date.now()
    }));
    
    return newsData;
  } catch (error) {
    console.error('Error fetching news:', error);
    return { sentiment: 'neutral', relevantNews: [], marketTrend: 'stable' };
  }
}

// Enhanced DefiLlama integration
const DEFI_LLAMA_POOLS_URL = "https://yields.llama.fi/pools";
const DEFI_LLAMA_POOL_CHART_URL = "https://yields.llama.fi/chart/";
const DEFI_LLAMA_TVL_URL = "https://api.llama.fi/protocols";

async function fetchDefiLlamaPoolsEnhanced() {
  try {
    if (fs.existsSync(POOLS_CACHE_FILE)) {
      const cached = JSON.parse(fs.readFileSync(POOLS_CACHE_FILE, 'utf8'));
      const cacheAge = Date.now() - cached.timestamp;
      if (cached && Array.isArray(cached.data) && cached.data.length > 0 && cacheAge < 3600000) { // 1 hour cache
        console.log(`Loaded ${cached.data.length} pools from cache (${Math.round(cacheAge/60000)}min old)`);
        return cached.data;
      }
    }
    
    console.log('Fetching fresh pool data from DefiLlama...');
    const response = await axios.get(DEFI_LLAMA_POOLS_URL, { timeout: 30000 });
    const allPools = response.data.data;
    
    // Enhanced filtering for multiple protocols
    const supportedProjects = ['uniswap-v3', 'sushiswap', 'balancer-v2', 'curve', 'pancakeswap'];
    const qualityPools = allPools
      .filter(pool => supportedProjects.includes(pool.project) && pool.chain === "Ethereum")
      .filter(isQualityPool)
      .sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0));
    
    console.log(`Filtered to ${qualityPools.length} quality pools from ${supportedProjects.join(', ')}`);
    
    // Cache with timestamp
    fs.writeFileSync(POOLS_CACHE_FILE, JSON.stringify({
      data: qualityPools,
      timestamp: Date.now()
    }));
    
    return qualityPools;
  } catch (error) {
    console.error('Error fetching DefiLlama pool data:', error.message);
    return [];
  }
}

async function fetchPoolChartEnhanced(poolId) {
  try {
    const url = DEFI_LLAMA_POOL_CHART_URL + encodeURIComponent(poolId);
    const response = await axios.get(url, { timeout: 25000 });
    
    if (response.data && Array.isArray(response.data.data)) {
      const daily = response.data.data;
      const result = {
        tvl: daily.map(d => ({ date: new Date(d.timestamp).getTime() / 1000, tvl: d.tvlUsd })),
        apy: daily.map(d => ({ date: new Date(d.timestamp).getTime() / 1000, apy: d.apy })),
        volume: daily.map(d => ({ date: new Date(d.timestamp).getTime() / 1000, volume: d.volumeUsd || 0 })),
        fees: daily.map(d => ({ date: new Date(d.timestamp).getTime() / 1000, fees: d.feesUsd || 0 }))
      };
      return result;
    }
    return {};
  } catch (error) {
    if (error.response && error.response.status === 429) {
      console.warn(`Rate limited on pool ${poolId}. Waiting 3 seconds...`);
      await delay(3000);
      return fetchPoolChartEnhanced(poolId);
    }
    console.error(`Error fetching chart for ${poolId}:`, error.message);
    return {};
  }
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// Enhanced processing with additional data points
let cachedPools = [];
let lastUpdated = null;
let processingStats = {
  totalProcessed: 0,
  successRate: 0,
  avgProcessingTime: 0,
  lastRunDuration: 0
};

function readProcessedIndex() {
  if (fs.existsSync(PROCESSED_INDEX_FILE)) {
    const data = JSON.parse(fs.readFileSync(PROCESSED_INDEX_FILE, 'utf8'));
    return typeof data.index === 'number' ? data.index : 0;
  }
  return 0;
}

function writeProcessedIndex(idx) {
  fs.writeFileSync(PROCESSED_INDEX_FILE, JSON.stringify({
    index: idx,
    timestamp: Date.now(),
    stats: processingStats
  }));
}

async function processPoolDataEnhanced() {
  const startTime = Date.now();
  
  try {
    console.log('Starting enhanced data processing...');
    const allPools = await fetchDefiLlamaPoolsEnhanced();
    
    if (!Array.isArray(allPools) || allPools.length === 0) {
      console.error('No pools returned. Skipping processing.');
      return [];
    }
    
    const processedPools = [];
    let checked = 0;
    let added = 0;
    let failed = 0;
    
    // Dynamic batch sizing based on API performance
    const POOLS_PER_REFRESH = 12; // Reduced for reliability
    const DELAY_BETWEEN_REQUESTS = 2500; // Increased delay
    const maxHistory = 365;
    
    let lastIndex = readProcessedIndex();
    if (lastIndex >= allPools.length) lastIndex = 0;
    
    // Fetch market sentiment
    const marketSentiment = await fetchDefiNews();
    
    for (let i = 0; i < POOLS_PER_REFRESH; i++) {
      const poolIdx = (lastIndex + i) % allPools.length;
      const pool = allPools[poolIdx];
      checked++;
      
      try {
        await delay(DELAY_BETWEEN_REQUESTS);
        const chart = await fetchPoolChartEnhanced(pool.pool);
        
        console.log(`Processing ${pool.symbol} (${pool.project}) - TVL: $${pool.tvlUsd?.toLocaleString()} - Chart: ${Array.isArray(chart.tvl) ? chart.tvl.length : 'N/A'} days`);
        
        if (!Array.isArray(chart.tvl) || chart.tvl.length < 7) {
          console.warn(`Insufficient data for ${pool.symbol} - skipping`);
          failed++;
          continue;
        }
        
        // Process historical data
        const tvlHistory = chart.tvl.slice(-maxHistory).map(h => h.tvl || 0);
        const aprHistory = chart.apy.slice(-maxHistory).map(h => h.apy || 0);
        const volumeHistory = chart.volume.slice(-maxHistory).map(h => h.volume || 0);
        const feesHistory = chart.fees.slice(-maxHistory).map(h => h.fees || 0);
        const dates = chart.tvl.slice(-maxHistory).map(e => new Date(e.date * 1000).toISOString().split('T')[0]);
        
        const tvl = pool.tvlUsd || (tvlHistory.length > 0 ? tvlHistory[tvlHistory.length - 1] : 0);
        const volume24h = pool.volumeUsd1d || (volumeHistory.length > 0 ? volumeHistory[volumeHistory.length - 1] : 0);
        const volatility = calculateVariance(tvlHistory);
        
        // Enhanced scoring factors
        const protocolRisk = assessProtocolRisk(pool.project);
        const governanceScore = calculateGovernanceScore(pool.project, tvl);
        
        const poolData = { 
          tvl, 
          volume24h, 
          aprHistory, 
          tvlHistory, 
          volatility, 
          protocolRisk,
          governanceScore,
          liquidityDepth: tvl / 1000000 
        };
        
        const healthScore = calculateHealthScore(poolData);
        const riskCategory = getRiskCategory(healthScore.totalScore);
        
        // Calculate additional metrics
        const avgApr = aprHistory.length > 0 ? aprHistory.reduce((sum, apr) => sum + apr, 0) / aprHistory.length : 0;
        const maxApr = aprHistory.length > 0 ? Math.max(...aprHistory) : 0;
        const minApr = aprHistory.length > 0 ? Math.min(...aprHistory) : 0;
        const aprVolatility = calculateVariance(aprHistory);
        
        // Volume trends (last 7 days vs previous 7 days)
        const recentVolume = volumeHistory.slice(-7);
        const previousVolume = volumeHistory.slice(-14, -7);
        const volumeTrend = recentVolume.length > 0 && previousVolume.length > 0 
          ? (recentVolume.reduce((sum, v) => sum + v, 0) / previousVolume.reduce((sum, v) => sum + v, 0)) - 1
          : 0;
        
        const processedPool = {
          pool_id: pool.pool,
          platform: pool.project,
          token_pair: pool.symbol,
          token0_symbol: pool.symbol.split('-')[0],
          token1_symbol: pool.symbol.split('-')[1] || '',
          tvl,
          volume_24h: volume24h,
          avg_volume: volumeHistory.length > 0 ? volumeHistory.reduce((sum, v) => sum + v, 0) / volumeHistory.length : 0,
          fee_tier: pool.metadata && pool.metadata.fee ? pool.metadata.fee : null,
          
          // Enhanced health metrics
          health_score: Math.round(healthScore.totalScore * 100) / 100,
          tvl_stability: healthScore.breakdown.tvlStability,
          apr_consistency: healthScore.breakdown.aprConsistency,
          volume_efficiency: healthScore.breakdown.volumeEfficiency,
          liquidity_score: healthScore.breakdown.liquidityScore,
          protocol_trust: healthScore.breakdown.protocolTrust,
          governance_score: healthScore.breakdown.governanceFactor,
          
          // Additional metrics
          risk_category: riskCategory,
          avg_apr: Math.round(avgApr * 100) / 100,
          max_apr: Math.round(maxApr * 100) / 100,
          min_apr: Math.round(minApr * 100) / 100,
          apr_volatility: Math.round(aprVolatility * 1000) / 1000,
          volume_trend: Math.round(volumeTrend * 1000) / 1000,
          data_points: tvlHistory.length,
          data_quality: tvlHistory.length >= 30 ? 'high' : tvlHistory.length >= 7 ? 'medium' : 'low',
          
          // Market context
          market_sentiment: marketSentiment.sentiment,
          
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
        
        console.log(`✓ ${pool.symbol} (${pool.project}) - Health: ${processedPool.health_score} (${riskCategory.label}) - Quality: ${processedPool.data_quality}`);
        
      } catch (error) {
        console.error(`Error processing pool ${pool.pool}:`, error.message);
        failed++;
      }
    }
    
    writeProcessedIndex((lastIndex + POOLS_PER_REFRESH) % allPools.length);
    
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
    
    // Sort by health score and keep top pools
    mergedPools.sort((a, b) => b.health_score - a.health_score);
    cachedPools = mergedPools.slice(0, 1000); // Keep top 1000 pools
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    // Update processing stats
    processingStats = {
      totalProcessed: processingStats.totalProcessed + checked,
      successRate: Math.round(((processingStats.totalProcessed * processingStats.successRate + added) / (processingStats.totalProcessed + checked)) * 100),
      avgProcessingTime: Math.round((processingStats.avgProcessingTime + duration/checked) / 2),
      lastRunDuration: duration
    };
    
    lastUpdated = new Date().toISOString();
    
    console.log(`Processing complete: ${checked} checked, ${added} added, ${failed} failed`);
    console.log(`Total cached pools: ${cachedPools.length}, Success rate: ${processingStats.successRate}%`);
    console.log(`Duration: ${Math.round(duration/1000)}s, Avg per pool: ${Math.round(duration/checked)}ms`);
    
    return processedPools;
  } catch (error) {
    console.error('Error in enhanced processing:', error);
    return [];
  }
}

// Risk category helper
function getRiskCategory(healthScore) {
  if (healthScore >= 80) return { label: 'Conservative', color: '#27ae60', description: 'Low risk, stable pools suitable for conservative investors' };
  if (healthScore >= 60) return { label: 'Moderate', color: '#f39c12', description: 'Medium risk, balanced risk-reward profile' };
  if (healthScore >= 40) return { label: 'Aggressive', color: '#e67e22', description: 'High risk, higher potential returns for experienced users' };
  return { label: 'Speculative', color: '#e74c3c', description: 'Very high risk, experimental pools for advanced users only' };
}

// Enhanced API routes
app.get('/', (req, res) => {
  res.json({
    message: 'Advanced DeFi Pool Risk Analyzer API (Enhanced)',
    status: 'running',
    version: '2.1.0',
    totalPools: cachedPools.length,
    lastUpdated,
    processingStats,
    supportedProtocols: ['uniswap-v3', 'sushiswap', 'balancer-v2', 'curve'],
    features: [
      'Multi-protocol support',
      'Enhanced risk scoring',
      'Market sentiment analysis',
      'Protocol risk assessment',
      'Governance scoring',
      'Volume trend analysis'
    ],
    endpoints: { 
      health: '/api/health', 
      pools: '/api/pools', 
      metrics: '/api/metrics', 
      refresh: '/api/refresh',
      top: '/api/top',
      stats: '/api/stats'
    },
    dataFrequency: 'Every 2 hours automatic, manual refresh processes 12 pools',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  const healthStats = {
    status: 'ok',
    uptime: process.uptime(),
    lastUpdated,
    totalPools: cachedPools.length,
    processingStats,
    memoryUsage: process.memoryUsage(),
    version: '2.1.0',
    dataLatency: lastUpdated ? Math.round((Date.now() - new Date(lastUpdated).getTime()) / 60000) : null
  };
  res.json(healthStats);
});

// Enhanced stats endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const pools = cachedPools;
    
    const platformDistribution = {};
    const qualityDistribution = { high: 0, medium: 0, low: 0 };
    const aprRanges = { low: 0, medium: 0, high: 0, extreme: 0 };
    
    pools.forEach(pool => {
      // Platform distribution
      platformDistribution[pool.platform] = (platformDistribution[pool.platform] || 0) + 1;
      
      // Quality distribution
      qualityDistribution[pool.data_quality]++;
      
      // APR ranges
      if (pool.avg_apr < 5) aprRanges.low++;
      else if (pool.avg_apr < 15) aprRanges.medium++;
      else if (pool.avg_apr < 50) aprRanges.high++;
      else aprRanges.extreme++;
    });
    
    const stats = {
      platformDistribution,
      qualityDistribution,
      aprRanges,
      processingStats,
      dataQuality: {
        totalPools: pools.length,
        avgDataPoints: pools.reduce((sum, p) => sum + p.data_points, 0) / pools.length,
        oldestData: Math.min(...pools.map(p => p.data_points)),
        newestData: Math.max(...pools.map(p => p.data_points))
      }
    };
    
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Keep existing API routes but enhance metrics
app.get('/api/pools', async (req, res) => {
  try {
    let { platform, minTvl, limit, sortBy, search, riskCategory, dataQuality } = req.query;
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
    
    if (dataQuality) {
      pools = pools.filter(p => p.data_quality === dataQuality);
    }
    
    // Apply sorting
    pools.sort((a, b) => {
      switch (sortBy) {
        case 'tvl':
          return b.tvl - a.tvl;
        case 'volume':
          return b.volume_24h - a.volume_24h;
        case 'apr':
          return b.avg_apr - a.avg_apr;
        case 'health_score':
        default:
          return b.health_score - a.health_score;
      }
    });
    
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
      },
      filters: { platform, minTvl, riskCategory, dataQuality, search },
      sortBy
    });
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
    
    // Enhanced metrics
    const avgApr = pools.reduce((sum, p) => sum + p.avg_apr, 0) / totalPools;
    const avgDataQuality = pools.reduce((sum, p) => sum + p.data_points, 0) / totalPools;
    
    const metrics = {
      totalPools,
      averageHealthScore: Math.round(averageHealthScore * 100) / 100,
      totalTvl,
      totalVolume24h,
      avgApr: Math.round(avgApr * 100) / 100,
      avgDataPoints: Math.round(avgDataQuality),
      dataLatency: Math.round((Date.now() - new Date(lastUpdated).getTime()) / 60000),
      riskDistribution: {
        conservative,
        moderate, 
        aggressive,
        speculative
      },
      topPerformers: pools.slice(0, 3).map(p => ({
        symbol: p.token_pair,
        platform: p.platform,
        healthScore: p.health_score,
        tvl: p.tvl,
        riskCategory: p.risk_category.label
      }))
    };
    
    res.json({ success: true, data: metrics, lastUpdated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Enhanced refresh with better feedback
app.post('/api/refresh', async (req, res) => {
  try {
    console.log('Manual enhanced refresh triggered...');
    const startTime = Date.now();
    const pools = await processPoolDataEnhanced();
    const duration = Date.now() - startTime;
    
    res.json({ 
      success: true, 
      message: `Enhanced refresh completed: ${pools.length} pools processed`,
      totalCached: cachedPools.length,
      duration: Math.round(duration/1000) + ' seconds',
      processingStats,
      data: pools.slice(0, 3) 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  try {
    console.log('Manual enhanced refresh triggered (GET)...');
    const pools = await processPoolDataEnhanced();
    res.json({ 
      success: true, 
      message: `Enhanced refresh completed: ${pools.length} pools processed`, 
      totalCached: cachedPools.length,
      processingStats,
      data: pools.slice(0, 3) 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Enhanced top pools endpoint
app.get('/api/top', async (req, res) => {
  try {
    const { category = 'health', limit = 10, platform } = req.query;
    let pools = [...cachedPools];
    
    if (platform && platform !== 'all') {
      pools = pools.filter(p => p.platform === platform);
    }
    
    switch (category) {
      case 'tvl':
        pools.sort((a, b) => b.tvl - a.tvl);
        break;
      case 'volume':
        pools.sort((a, b) => b.volume_24h - a.volume_24h);
        break;
      case 'apr':
        pools.sort((a, b) => b.avg_apr - a.avg_apr);
        break;
      case 'conservative':
        pools = pools.filter(p => p.health_score >= 80).sort((a, b) => b.health_score - a.health_score);
        break;
      case 'trending':
        pools.sort((a, b) => b.volume_trend - a.volume_trend);
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

// Pool-specific endpoint
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

// Scheduled updates - every 2 hours for enhanced processing
cron.schedule('0 */2 * * *', async () => {
  console.log('Running scheduled enhanced data update...');
  await processPoolDataEnhanced();
});

// Initial load with enhanced processing
setTimeout(async () => {
  console.log('Loading initial enhanced data...');
  await processPoolDataEnhanced();
}, 15000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Advanced DeFi Pool Risk Analyzer API v2.1 (Enhanced) running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Enhanced features: Multi-protocol, governance scoring, market sentiment`);
  console.log(`Data updates: Every 2 hours automatic, 12 pools per manual refresh`);
});
