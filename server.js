import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Example route
app.get("/api/pools", (req, res) => {
  res.json({
    success: true,
    data: [
      {
        pool_id: "uniswap-eth-usdc",
        platform: "uniswap-v3",
        token_pair: "ETH/USDC",
        tvl: 5000000,
        volume_24h: 1200000,
        fee_tier: 0.003,
        health_score: 85,
        tvl_stability: 80,
        apr_consistency: 75,
        il_risk_score: 10,
        historical_data: {
          dates: ["2025-09-01", "2025-09-02"],
          tvl: [5000000, 5200000],
          volume: [1200000, 1250000],
          fees: [3600, 3750],
          apr: [15, 16]
        }
      }
    ]
  });
});

app.get("/api/metrics", (req, res) => {
  res.json({
    success: true,
    data: {
      totalPools: 1,
      averageHealthScore: 85,
      totalTvl: 5000000,
      highRiskPools: 0,
      totalVolume24h: 1200000
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
