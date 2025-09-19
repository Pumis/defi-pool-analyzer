// app.js - Enhanced DeFi Pool Analyzer Backend with 2-Year Data Collection
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

// Enhanced Health scoring algorithm - Updated for 2-year data collection
function calculateHealthScore(poolData) {
    const { tvl, volume24h, aprHistory, tvlHistory, volatility, protocolRisk, governanceScore, tokenPair, platform } = poolData;
    
    // 1. Liquidity Risk Assessment (25 points) - Most critical factor
    const tvlVariance = calculateVariance(tvlHistory);
    const liquidityRisk = Math.max(0, Math.min(25, 25 * Math.exp(-tvlVariance * 2))); // Adjusted sensitivity
    
    // Bonus for absolute liquidity size (deeper = safer)
    const liquidityBonus = Math.min(5, Math.log(Math.max(tvl, 10000)) / Math.log(10) - 4);
    const totalLiquidityScore = Math.min(25, liquidityRisk + liquidityBonus);
    
    // 2. FIXED: Yield Sustainability Assessment (20 points) - No longer rewards terrible but stable yields
    const avgApr = aprHistory.length > 0 ? aprHistory.reduce((sum, apr) => sum + apr, 0) / aprHistory.length : 0;
    let yieldSustainabilityScore;
    
    // Heavily penalize very low yields regardless of stability
    if (avgApr < 0.5) yieldSustainabilityScore = 1;                       // Terrible: <0.5% (essentially dead pools)
    else if (avgApr >= 0.5 && avgApr < 2) yieldSustainabilityScore = 4;   // Very poor: 0.5-2% 
    else if (avgApr >= 2 && avgApr < 5) yieldSustainabilityScore = 12;    // Low but acceptable: 2-5%
    else if (avgApr >= 5 && avgApr <= 15) yieldSustainabilityScore = 20;  // Optimal: 5-15% (realistic sustainable)
    else if (avgApr > 15 && avgApr <= 25) yieldSustainabilityScore = 16;  // Good but higher risk: 15-25% 
    else if (avgApr > 25 && avgApr <= 40) yieldSustainabilityScore = 10;  // Moderate risk: 25-40%
    else if (avgApr > 40 && avgApr <= 60) yieldSustainabilityScore = 6;   // High risk: 40-60%
    else yieldSustainabilityScore = 2;                                    // Very high risk: >60%
    
    // IMPROVED: Volatility calculation that handles temporary spikes better
    const aprVolatilityRobust = calculateRobustVolatility(aprHistory);
    
    // Stability bonus/penalty - but capped so terrible yields can't become good
    const stabilityMultiplier = Math.max(0.5, Math.min(1.3, 1 + (0.3 * Math.exp(-aprVolatilityRobust * 3) - 0.15)));
    const totalYieldScore = Math.max(0, Math.min(20, yieldSustainabilityScore * stabilityMultiplier));
    
    // 3. Impermanent Loss Risk (20 points)
    const impermanentLossRisk = assessImpermanentLossRisk(tokenPair, aprHistory, tvlHistory);
    
    // 4. Protocol Security & Maturity (15 points)
    const protocolScore = Math.min(15, Math.max(0, protocolRisk * 15));
    
    // 5. Market Activity Health (10 points)
    const volumeToTvlRatio = volume24h / Math.max(tvl, 1);
    let activityScore;
    
    if (volumeToTvlRatio < 0.005) activityScore = 3;       // Very low activity
    else if (volumeToTvlRatio < 0.02) activityScore = 6;   // Low but healthy activity
    else if (volumeToTvlRatio < 0.1) activityScore = 10;   // Optimal activity level
    else if (volumeToTvlRatio < 0.5) activityScore = 7;    // High activity
    else activityScore = 3;                                // Excessive activity
    
    // 6. ENHANCED: Survivability & Risk-Adjusted Returns (15 points total)
    const dataPoints = Math.min(aprHistory.length, tvlHistory.length);
    
    // A. Enhanced Track Record Scoring (10 points) - Bigger bonus for longer survival
    let trackRecordScore;
    if (dataPoints < 90) trackRecordScore = 0;              // <3 months = 0 points
    else if (dataPoints < 180) trackRecordScore = 2;        // 3-6 months = 2 points
    else if (dataPoints < 365) trackRecordScore = 5;        // 6-12 months = 5 points  
    else if (dataPoints < 730) trackRecordScore = 8;        // 1-2 years = 8 points
    else trackRecordScore = 10;                             // 2+ years = 10 points (big survivability bonus)
    
    // B. Risk-Adjusted Return Score (5 points) - Sharpe-like ratio
    let riskAdjustedScore = 0;
    if (aprHistory.length > 30 && aprVolatilityRobust > 0) {
        const sharpeRatio = avgApr / (aprVolatilityRobust * 100); // Normalize volatility
        if (sharpeRatio > 0.3) riskAdjustedScore = 5;       // Excellent risk-adjusted return
        else if (sharpeRatio > 0.2) riskAdjustedScore = 4;  // Good risk-adjusted return  
        else if (sharpeRatio > 0.1) riskAdjustedScore = 2;  // Fair risk-adjusted return
        else riskAdjustedScore = 0;                         // Poor risk-adjusted return
    }
    
    // 7. ADDED: Whale Concentration Risk Assessment (modifies liquidity score)
    const whaleRiskPenalty = assessWhaleConcentrationRisk(tvl, volume24h);
    const adjustedLiquidityScore = Math.max(0, totalLiquidityScore - whaleRiskPenalty);
    
    const totalScore = adjustedLiquidityScore + totalYieldScore + impermanentLossRisk + protocolScore + activityScore + trackRecordScore + riskAdjustedScore;
    
    // Apply pool type multiplier for final score
    const poolTypeMultiplier = getPoolTypeMultiplier(tokenPair, platform || 'unknown');
    const finalScore = Math.min(100, Math.max(0, totalScore * poolTypeMultiplier));
    
    return {
        totalScore: finalScore,
        breakdown: { 
            liquidityScore: Math.round(adjustedLiquidityScore * 100) / 100,
            yieldScore: Math.round(totalYieldScore * 100) / 100,
            impermanentLossScore: Math.round(impermanentLossRisk * 100) / 100,
            protocolScore: Math.round(protocolScore * 100) / 100,
            activityScore: Math.round(activityScore * 100) / 100,
            trackRecordScore: Math.round(trackRecordScore * 100) / 100,
            riskAdjustedScore: Math.round(riskAdjustedScore * 100) / 100,
            whaleRiskPenalty: Math.round(whaleRiskPenalty * 100) / 100,
            poolTypeMultiplier: Math.round(poolTypeMultiplier * 1000) / 1000
        }
    };
}

// Enhanced Impermanent Loss Risk Assessment  
function assessImpermanentLossRisk(tokenPair, aprHistory, tvlHistory) {
    if (!tokenPair) return 10;
    
    const tokens = tokenPair.toLowerCase().split('-');
    const stablecoins = ['usdc', 'usdt', 'dai', 'frax', 'lusd', 'busd', 'usdd'];
    const correlatedPairs = [
        ['weth', 'eth'], ['wbtc', 'btc'], ['steth', 'weth'], ['wsteth', 'weth'], 
        ['reth', 'weth'], ['cbeth', 'weth'], ['usdc', 'usdt'], ['dai', 'usdc']
    ];
    
    // Check for stablecoin pairs (lowest IL risk)
    const stablecoinCount = tokens.filter(token => stablecoins.includes(token)).length;
    if (stablecoinCount === 2) return 20; // Both stablecoins - minimal IL risk
    
    // Check for highly correlated pairs (low IL risk)
    const isCorrelated = correlatedPairs.some(pair => 
        (tokens.includes(pair[0]) && tokens.includes(pair[1])) ||
        (tokens.includes(pair[1]) && tokens.includes(pair[0]))
    );
    if (isCorrelated) return 18; // Highly correlated - low IL risk
    
    // One stablecoin + one volatile (moderate IL risk)
    if (stablecoinCount === 1) return 15;
    
    // Major tokens (ETH, BTC derivatives) - moderate IL risk
    const majorTokens = ['weth', 'eth', 'wbtc', 'btc'];
    const majorTokenCount = tokens.filter(token => majorTokens.includes(token)).length;
    if (majorTokenCount >= 1) return 12;
    
    // Established DeFi tokens - higher IL risk
    const establishedTokens = ['uni', 'link', 'aave', 'crv', 'bal', 'comp', 'mkr', 'snx'];
    const establishedCount = tokens.filter(token => establishedTokens.includes(token)).length;
    if (establishedCount >= 1) return 10;
    
    // Check for extreme volatility indicators in historical data
    if (aprHistory.length > 30) { // Use 30-day window for 2-year data
        const recentAprVolatility = calculateVariance(aprHistory.slice(-30));
        if (recentAprVolatility > 0.5) return 5;
    }
    
    if (tvlHistory.length > 30) {
        const recentTvlVolatility = calculateVariance(tvlHistory.slice(-30));
        if (recentTvlVolatility > 0.3) return 6;
    }
    
    return 8; // Unknown token pairs - highest IL risk
}

// ADDED: Whale Concentration Risk Assessment
function assessWhaleConcentrationRisk(tvl, volume24h) {
    // Simulate whale dominance based on pool characteristics
    const volumeToTvlRatio = tvl > 0 ? volume24h / tvl : 0;
    
    // Pools with very low activity relative to size suggest concentrated holdings
    if (tvl > 5000000 && volumeToTvlRatio < 0.001) {
        return 5; // Large pool with very low activity = whale dominated, high risk
    } else if (tvl > 1000000 && volumeToTvlRatio < 0.005) {
        return 3; // Medium pool with low activity = some concentration risk
    } else if (volumeToTvlRatio < 0.01) {
        return 1; // Minor concentration risk
    }
    
    return 0; // No significant whale concentration detected
}

// ADDED: Enhanced pool type weighting
function getPoolTypeMultiplier(tokenPair, platform) {
    if (!tokenPair) return 1;
    
    const tokens = tokenPair.toLowerCase().split('-');
    const stablecoins = ['usdc', 'usdt', 'dai', 'frax', 'lusd', 'busd'];
    const majorTokens = ['weth', 'eth', 'wbtc', 'btc'];
    
    const stablecoinCount = tokens.filter(token => stablecoins.includes(token)).length;
    const majorTokenCount = tokens.filter(token => majorTokens.includes(token)).length;
    
    // Stablecoin pairs get slight bonus for stability
    if (stablecoinCount === 2) return 1.05;
    
    // Major token pairs get small bonus for established nature
    if (majorTokenCount >= 1) return 1.02;
    
    // Curve pools (specialized for stables) get bonus when appropriate
    if (platform === 'curve' && stablecoinCount >= 1) return 1.03;
    
    return 1; // Default multiplier
}

function calculateVariance(values) {
    if (!values || values.length < 2) return 0;
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    if (mean === 0) return 0;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance) / mean;
}

// ADDED: Robust volatility calculation that handles temporary spikes better
function calculateRobustVolatility(values, percentileThreshold = 0.9) {
    if (!values || values.length < 10) return 0;
    
    // Calculate rolling 30-day volatilities to identify consistent vs. spike-driven volatility
    const windowSize = Math.min(30, Math.floor(values.length / 4));
    const rollingVolatilities = [];
    
    for (let i = windowSize; i < values.length; i++) {
        const window = values.slice(i - windowSize, i);
        const windowMean = window.reduce((sum, val) => sum + val, 0) / window.length;
        if (windowMean > 0) {
            const windowVariance = window.reduce((sum, val) => sum + Math.pow(val - windowMean, 2), 0) / window.length;
            rollingVolatilities.push(Math.sqrt(windowVariance) / windowMean);
        }
    }
    
    if (rollingVolatilities.length === 0) return 0;
    
    // Use median volatility instead of mean to reduce impact of temporary spikes
    rollingVolatilities.sort((a, b) => a - b);
    const medianIndex = Math.floor(rollingVolatilities.length / 2);
    const medianVolatility = rollingVolatilities.length % 2 === 0 
        ? (rollingVolatilities[medianIndex - 1] + rollingVolatilities[medianIndex]) / 2
        : rollingVolatilities[medianIndex];
    
    return medianVolatility;
}

// Protocol risk assessment - updated scores
function assessProtocolRisk(project) {
    const protocolRisk = {
        'uniswap-v3': 0.9,   // Very established
        'sushiswap': 0.8,    // Established
        'balancer-v2': 0.75, // Moderate
        'curve': 0.85,       // Very established for stables
        'pancakeswap': 0.6,  // Less established on mainnet
        'default': 0.5
    };
    return protocolRisk[project] || protocolRisk['default'];
}

// Enhanced pool quality filtering
function isQualityPool(pool) {
    if (pool.tvlUsd < 5000) return false; // Minimum TVL threshold
    if (!pool.symbol || !pool.symbol.includes('-')) return false;
    
    // Enhanced filtering for better pool selection
    const majorTokens = ['WETH', 'USDC', 'USDT', 'DAI', 'WBTC', 'UNI', 'LINK', 'AAVE', 'CRV', 'BAL'];
    const stablecoins = ['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD'];
    const tokens = pool.symbol.split('-');
    
    const hasMajorToken = tokens.some(token => majorTokens.includes(token));
    const hasStablecoin = tokens.some(token => stablecoins.includes(token));
    const isHighTvl = pool.tvlUsd > 50000;
    
    return isHighTvl || hasMajorToken || hasStablecoin;
}

// Enhanced DefiLlama integration with 2-year data collection
const DEFI_LLAMA_POOLS_URL = "https://yields.llama.fi/pools";
const DEFI_LLAMA_POOL_CHART_URL = "https://yields.llama.fi/chart/";

async function fetchDefiLlamaPoolsEnhanced() {
    try {
        if (fs.existsSync(POOLS_CACHE_FILE)) {
            const cached = JSON.parse(fs.readFileSync(POOLS_CACHE_FILE, 'utf8'));
            const cacheAge = Date.now() - cached.timestamp;
            if (cached && Array.isArray(cached.data) && cached.data.length > 0 && cacheAge < 3600000) {
                console.log(`Loaded ${cached.data.length} pools from cache (${Math.round(cacheAge/60000)}min old)`);
                return cached.data;
            }
        }
        
        console.log('Fetching fresh pool data from DefiLlama...');
        const response = await axios.get(DEFI_LLAMA_POOLS_URL, { timeout: 30000 });
        const allPools = response.data.data;
        
        const supportedProjects = ['uniswap-v3', 'sushiswap', 'balancer-v2', 'curve', 'pancakeswap'];
        const qualityPools = allPools
            .filter(pool => supportedProjects.includes(pool.project) && pool.chain === "Ethereum")
            .filter(isQualityPool)
            .sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0));
        
        console.log(`Filtered to ${qualityPools.length} quality pools from ${supportedProjects.join(', ')}`);
        
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
        const response = await axios.get(url, { timeout: 30000 });
        
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

// Enhanced processing with 2-year data collection
let cachedPools = [];
let lastUpdated = null;
let processingStats = {
    totalProcessed: 0,
    successRate: 0,
    avgProcessingTime: 0,
    lastRunDuration: 0
};

function getLastProcessedIndex() {
    try {
        if (fs.existsSync(PROCESSED_INDEX_FILE)) {
            const data = JSON.parse(fs.readFileSync(PROCESSED_INDEX_FILE, 'utf8'));
            return data.index || 0;
        }
    } catch (error) {
        console.error('Error reading last processed index:', error.message);
    }
    return 0;
}

function saveLastProcessedIndex(index) {
    try {
        fs.writeFileSync(PROCESSED_INDEX_FILE, JSON.stringify({ 
            index, 
            timestamp: Date.now() 
        }));
    } catch (error) {
        console.error('Error saving last processed index:', error.message);
    }
}

// Enhanced pool processing for 2-year data - UPDATED FOR 730 DAYS
async function processPoolDataEnhanced(pool, maxHistory = 730) { // Changed from 365 to 730
    const startTime = Date.now();
    
    try {
        console.log(`Processing pool: ${pool.symbol} (${pool.pool})`);
        
        // Fetch historical chart data
        const chart = await fetchPoolChartEnhanced(pool.pool);
        
        if (!chart.tvl || !chart.apy || chart.tvl.length === 0 || chart.apy.length === 0) {
            console.log(`No chart data for ${pool.symbol}`);
            return null;
        }
        
        // Extract 2-year history (or available history)
        const tvlHistory = chart.tvl.slice(-maxHistory).map(h => h.tvl || 0);
        const aprHistory = chart.apy.slice(-maxHistory).map(h => h.apy || 0);
        const volumeHistory = chart.volume ? chart.volume.slice(-maxHistory).map(h => h.volume || 0) : [];
        const feesHistory = chart.fees ? chart.fees.slice(-maxHistory).map(h => h.fees || 0) : [];
        
        // Enhanced volatility calculations for 2-year data - FIXED to use robust calculation
        const aprVolatility = calculateRobustVolatility(aprHistory);
        const tvlVolatility = calculateVariance(tvlHistory);
        
        // Protocol risk assessment
        const protocolRisk = assessProtocolRisk(pool.project);
        
        // Calculate comprehensive health score
        const healthData = calculateHealthScore({
            tvl: pool.tvlUsd,
            volume24h: pool.volumeUsd1d || 0,
            aprHistory,
            tvlHistory,
            volatility: aprVolatility,
            protocolRisk,
            governanceScore: 0.8, // Placeholder
            tokenPair: pool.symbol,
            platform: pool.project
        });
        
        // Risk categorization with enhanced thresholds
        let riskCategory;
        if (healthData.totalScore >= 80) {
            riskCategory = { label: 'Conservative', description: 'Low risk with stable fundamentals and proven track record.' };
        } else if (healthData.totalScore >= 60) {
            riskCategory = { label: 'Moderate', description: 'Balanced risk-return profile suitable for moderate investors.' };
        } else if (healthData.totalScore >= 40) {
            riskCategory = { label: 'Aggressive', description: 'Higher risk requiring active monitoring but potential for good returns.' };
        } else {
            riskCategory = { label: 'Speculative', description: 'High risk investment suitable only for experienced investors.' };
        }
        
        // Data quality assessment
        let dataQuality;
        const dataPoints = Math.min(aprHistory.length, tvlHistory.length);
        if (dataPoints >= 730) dataQuality = 'Excellent';      // 2+ years
        else if (dataPoints >= 365) dataQuality = 'Good';      // 1+ years  
        else if (dataPoints >= 180) dataQuality = 'Fair';      // 6+ months
        else if (dataPoints >= 90) dataQuality = 'Limited';    // 3+ months
        else dataQuality = 'Insufficient';                     // <3 months
        
        // Format historical data for frontend
        const dates = chart.tvl.slice(-maxHistory).map(h => 
            new Date(h.date * 1000).toLocaleDateString()
        );
        
        const processedPool = {
            pool_id: pool.pool,
            token_pair: pool.symbol,
            platform: pool.project,
            chain: pool.chain,
            tvl: pool.tvlUsd,
            volume_24h: pool.volumeUsd1d || 0,
            avg_apr: aprHistory.length > 0 ? aprHistory.reduce((sum, apr) => sum + apr, 0) / aprHistory.length : 0,
            health_score: healthData.totalScore,
            risk_category: riskCategory,
            data_quality: dataQuality,
            data_points: dataPoints,
            
            // Individual scoring components
            liquidity_score: healthData.breakdown.liquidityScore,
            yield_score: healthData.breakdown.yieldScore,
            impermanent_loss_score: healthData.breakdown.impermanentLossScore,
            protocol_score: healthData.breakdown.protocolScore,
            activity_score: healthData.breakdown.activityScore,
            track_record_score: healthData.breakdown.trackRecordScore,
            risk_adjusted_score: healthData.breakdown.riskAdjustedScore,
            whale_risk_penalty: healthData.breakdown.whaleRiskPenalty,
            pool_type_multiplier: healthData.breakdown.poolTypeMultiplier,
            
            // Enhanced risk metrics
            apr_volatility: aprVolatility,
            tvl_volatility: tvlVolatility,
            
            // Historical data for charting
            historical_data: {
                dates: dates,
                tvl: tvlHistory,
                apr: aprHistory,
                volume: volumeHistory,
                fees: feesHistory
            },
            
            // Metadata
            last_updated: new Date().toISOString(),
            processing_time: Date.now() - startTime
        };
        
        console.log(`✓ Processed ${pool.symbol}: Health Score ${healthData.totalScore.toFixed(1)}/100 (${dataPoints} days of data)`);
        return processedPool;
        
    } catch (error) {
        console.error(`Error processing pool ${pool.symbol}:`, error.message);
        return null;
    }
}

// Enhanced batch processing with better error handling
async function processPoolsBatch(pools, startIndex = 0, batchSize = 5) {
    const results = [];
    const errors = [];
    let successCount = 0;
    const totalStartTime = Date.now();
    
    console.log(`\n🔄 Processing batch of ${pools.length} pools starting from index ${startIndex}...`);
    
    for (let i = 0; i < pools.length; i += batchSize) {
        const batch = pools.slice(i, i + batchSize);
        console.log(`\nProcessing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(pools.length/batchSize)} (pools ${i+1}-${Math.min(i+batchSize, pools.length)})`);
        
        const batchPromises = batch.map(async (pool, batchIndex) => {
            try {
                const processed = await processPoolDataEnhanced(pool);
                if (processed) {
                    successCount++;
                    return processed;
                }
            } catch (error) {
                const globalIndex = startIndex + i + batchIndex;
                errors.push({ pool: pool.symbol, index: globalIndex, error: error.message });
                console.error(`❌ Failed to process ${pool.symbol} (index ${globalIndex}):`, error.message);
            }
            return null;
        });
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults.filter(result => result !== null));
        
        // Rate limiting - wait between batches
        if (i + batchSize < pools.length) {
            console.log('⏱️ Waiting 2 seconds between batches...');
            await delay(2000);
        }
        
        // Save progress periodically
        const currentIndex = startIndex + i + batchSize;
        saveLastProcessedIndex(currentIndex);
    }
    
    const totalDuration = Date.now() - totalStartTime;
    const successRate = pools.length > 0 ? (successCount / pools.length) * 100 : 0;
    
    // Update processing stats
    processingStats = {
        totalProcessed: pools.length,
        successCount,
        successRate: successRate,
        avgProcessingTime: results.length > 0 ? results.reduce((sum, p) => sum + p.processing_time, 0) / results.length : 0,
        lastRunDuration: totalDuration,
        errors: errors.length
    };
    
    console.log(`\n📊 Batch Processing Complete:`);
    console.log(`   ✓ Successfully processed: ${successCount}/${pools.length} pools (${successRate.toFixed(1)}%)`);
    console.log(`   ❌ Errors: ${errors.length}`);
    console.log(`   ⏱️ Total time: ${(totalDuration/1000).toFixed(1)}s`);
    console.log(`   📈 Average processing time: ${processingStats.avgProcessingTime.toFixed(0)}ms per pool`);
    
    return { results, errors, stats: processingStats };
}

// Enhanced caching and data management
function saveCachedPools(pools) {
    try {
        const cacheData = {
            pools: pools,
            timestamp: Date.now(),
            totalCount: pools.length,
            stats: processingStats
        };
        
        fs.writeFileSync(METRICS_CACHE_FILE, JSON.stringify(cacheData, null, 2));
        console.log(`💾 Cached ${pools.length} processed pools`);
    } catch (error) {
        console.error('Error saving cached pools:', error.message);
    }
}

function loadCachedPools() {
    try {
        if (fs.existsSync(METRICS_CACHE_FILE)) {
            const cached = JSON.parse(fs.readFileSync(METRICS_CACHE_FILE, 'utf8'));
            const cacheAge = Date.now() - cached.timestamp;
            
            if (cached.pools && Array.isArray(cached.pools) && cacheAge < 7200000) { // 2 hours cache
                console.log(`📁 Loaded ${cached.pools.length} pools from cache (${Math.round(cacheAge/60000)}min old)`);
                lastUpdated = new Date(cached.timestamp);
                processingStats = cached.stats || processingStats;
                return cached.pools;
            }
        }
    } catch (error) {
        console.error('Error loading cached pools:', error.message);
    }
    return [];
}

// Main data processing pipeline
async function updatePoolData() {
    console.log('\n🚀 Starting enhanced pool data update...');
    const startTime = Date.now();
    
    try {
        // Fetch raw pool data
        const rawPools = await fetchDefiLlamaPoolsEnhanced();
        if (rawPools.length === 0) {
            console.log('❌ No pools fetched, keeping cached data');
            return;
        }
        
        // Process pools in batches for better performance and API compliance
        const lastIndex = getLastProcessedIndex();
        const poolsToProcess = rawPools.slice(0, 50); // Limit for demo
        
        const { results, errors, stats } = await processPoolsBatch(poolsToProcess, 0, 3);
        
        if (results.length > 0) {
            // Sort by health score
            results.sort((a, b) => b.health_score - a.health_score);
            
            cachedPools = results;
            lastUpdated = new Date();
            
            // Save processed data
            saveCachedPools(results);
            
            console.log(`\n🎉 Pool update complete! Processed ${results.length} pools in ${((Date.now() - startTime)/1000).toFixed(1)}s`);
        } else {
            console.log('❌ No pools successfully processed');
        }
        
    } catch (error) {
        console.error('❌ Error in updatePoolData:', error.message);
    }
}

// API Routes

// Get processed pools with filtering
app.get('/api/pools', async (req, res) => {
    try {
        let pools = cachedPools.length > 0 ? cachedPools : loadCachedPools();
        
        // Apply filters
        const { platform, minTvl, riskCategory, search, limit = 20 } = req.query;
        
        if (platform && platform !== 'all') {
            pools = pools.filter(p => p.platform === platform);
        }
        
        if (minTvl) {
            pools = pools.filter(p => p.tvl >= parseFloat(minTvl));
        }
        
        if (riskCategory && riskCategory !== 'all') {
            const categoryMap = {
                'conservative': (score) => score >= 80,
                'moderate': (score) => score >= 60 && score < 80,
                'aggressive': (score) => score >= 40 && score < 60,
                'speculative': (score) => score < 40
            };
            const filterFn = categoryMap[riskCategory];
            if (filterFn) {
                pools = pools.filter(p => filterFn(p.health_score));
            }
        }
        
        if (search) {
            const searchLower = search.toLowerCase();
            pools = pools.filter(p => 
                p.token_pair.toLowerCase().includes(searchLower) ||
                p.platform.toLowerCase().includes(searchLower)
            );
        }
        
        // Limit results
        pools = pools.slice(0, parseInt(limit));
        
        res.json({
            success: true,
            data: pools,
            total: pools.length,
            lastUpdated: lastUpdated,
            stats: processingStats
        });
        
    } catch (error) {
        console.error('Error in /api/pools:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Get specific pool details
app.get('/api/pools/:poolId', (req, res) => {
    try {
        const pools = cachedPools.length > 0 ? cachedPools : loadCachedPools();
        const pool = pools.find(p => p.pool_id === req.params.poolId);
        
        if (pool) {
            res.json({ success: true, data: pool });
        } else {
            res.status(404).json({ success: false, error: 'Pool not found' });
        }
    } catch (error) {
        console.error('Error in /api/pools/:poolId:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get system statistics
app.get('/api/stats', (req, res) => {
    try {
        const pools = cachedPools.length > 0 ? cachedPools : loadCachedPools();
        
        const stats = {
            totalPools: pools.length,
            lastUpdated: lastUpdated,
            processingStats,
            healthScoreDistribution: {
                excellent: pools.filter(p => p.health_score >= 80).length,
                good: pools.filter(p => p.health_score >= 60 && p.health_score < 80).length,
                fair: pools.filter(p => p.health_score >= 40 && p.health_score < 60).length,
                poor: pools.filter(p => p.health_score < 40).length
            },
            platformDistribution: pools.reduce((acc, pool) => {
                acc[pool.platform] = (acc[pool.platform] || 0) + 1;
                return acc;
            }, {}),
            totalTvl: pools.reduce((sum, p) => sum + p.tvl, 0),
            totalVolume: pools.reduce((sum, p) => sum + p.volume_24h, 0),
            averageHealthScore: pools.length > 0 ? pools.reduce((sum, p) => sum + p.health_score, 0) / pools.length : 0
        };
        
        res.json({ success: true, data: stats });
    } catch (error) {
        console.error('Error in /api/stats:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Manual refresh endpoint
app.post('/api/refresh', async (req, res) => {
    try {
        console.log('🔄 Manual refresh requested');
        res.json({ 
            success: true, 
            message: 'Data refresh started. This may take several minutes.' 
        });
        
        // Start update in background
        updatePoolData().catch(console.error);
        
    } catch (error) {
        console.error('Error in /api/refresh:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    const pools = cachedPools.length > 0 ? cachedPools : loadCachedPools();
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        poolsCount: pools.length,
        lastUpdated: lastUpdated,
        uptime: process.uptime()
    });
});

// Serve static files
app.use(express.static('public'));

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        success: false, 
        error: 'Internal server error' 
    });
});

// Initialize and start server
async function startServer() {
    try {
        // Load cached data on startup
        cachedPools = loadCachedPools();
        
        // Initial data update if no cached data
        if (cachedPools.length === 0) {
            console.log('No cached data found, starting initial data fetch...');
            await updatePoolData();
        }
        
        // Schedule regular updates every 2 hours
        cron.schedule('0 */2 * * *', () => {
            console.log('\n⏰ Scheduled update starting...');
            updatePoolData().catch(console.error);
        });
        
        // Start the server
        app.listen(PORT, () => {
            console.log(`\n🚀 DeFi Pool Health Analyzer started!`);
            console.log(`   📊 Server running on port ${PORT}`);
            console.log(`   💾 ${cachedPools.length} pools loaded`);
            console.log(`   📅 Last updated: ${lastUpdated ? lastUpdated.toLocaleString() : 'Never'}`);
            console.log(`   🔄 Next update: Every 2 hours`);
            console.log(`\n📍 API Endpoints:`);
            console.log(`   GET  /api/pools     - Get filtered pools`);
            console.log(`   GET  /api/stats     - Get system statistics`);
            console.log(`   POST /api/refresh   - Manual data refresh`);
            console.log(`   GET  /api/health    - Health check\n`);
        });
        
    } catch (error) {
        console.error('❌ Failed to start server:', error.message);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM received, shutting down gracefully...');
    process.exit(0);
});

// Start the application
startServer();
