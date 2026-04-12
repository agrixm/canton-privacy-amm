# Canton Privacy AMM

[![CI](https://github.com/digital-asset/canton-privacy-amm/actions/workflows/ci.yml/badge.svg)](https://github.com/digital-asset/canton-privacy-amm/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A Uniswap v3-style Automated Market Maker (AMM) with shielded liquidity pools for KYC-cleared institutions on the Canton Network.

This project implements a constant-product AMM where parties can trade assets and provide liquidity. The key innovation is leveraging Canton's privacy model to ensure that liquidity positions are visible only to the provider and the protocol operator, protecting institutional strategies from public disclosure.

---

## Overview

Public blockchain AMMs like Uniswap expose all liquidity positions and trades transparently on-chain. While this enables "trustless" composability, it also exposes the strategies of institutional market makers, making them vulnerable to front-running and copy-trading.

The Canton Privacy AMM solves this by building on a privacy-by-design distributed ledger. It offers the familiar mechanics of a modern AMM while providing the confidentiality required for institutional finance.

### Key Features

*   **Concentrated Liquidity:** Inspired by Uniswap v3, LPs can provide liquidity within specific price ranges (ticks) to improve capital efficiency.
*   **Constant Product Invariant:** Swaps are executed against the classic `x * y = k` formula, aggregated across all active liquidity in the traded price range.
*   **Configurable Fee Tiers:** Each asset pair can have multiple liquidity pools with different swap fees (e.g., 0.05%, 0.30%, 1.00%), allowing LPs to choose the tier that best matches the assets' expected volatility.
*   **Shielded LP Positions:** An institution's liquidity position (size, price range) is a private Daml contract. Only the liquidity provider and the AMM operator are stakeholders. Other network participants cannot see the size or terms of individual positions.
*   **Institutional Grade:** Designed for permissioned environments where all participants are known, KYC-cleared entities.

## The Privacy Model Explained

On a public blockchain, when a large market maker adds or removes liquidity from a pool, that action is visible to everyone. This information leakage can be exploited by other traders.

Canton avoids this problem through its "subgraph privacy" model. Here’s how it works in our AMM:

1.  **Private Contracts:** When a Liquidity Provider (e.g., `HedgeFundA`) decides to provide liquidity, they create an `LpPosition` contract.
2.  **Strict Stakeholders:** The stakeholders on this contract are only `HedgeFundA` and the `AmmOperator`. According to Canton's protocol, only stakeholders of a contract ever see its data or are even aware of its existence.
3.  **No Data Leakage:** Another trader, `BankB`, who interacts with the same pool, has no visibility into `HedgeFundA`'s specific `LpPosition` contract. `BankB` only sees the *aggregated* liquidity available at a given price tick, without any attribution to its providers.
4.  **Protected Strategies:** This shielding means `HedgeFundA` can deploy and manage its capital without revealing its book to competitors or the broader market, preventing common exploits and preserving the value of its trading strategies.

The AMM operator acts as a central counterparty for swaps but orchestrates the settlement privately with the relevant LPs whose positions are in range for the trade.

## Liquidity Provider Quickstart Guide

This guide walks you through setting up the environment, deploying the AMM, and creating a liquidity position on a local Canton ledger.

### Prerequisites

*   **DPM (Daml Package Manager):** Ensure you have the Canton SDK installed. Follow the instructions [here](https://docs.digitalasset.com/canton/stable/user-manual/getting-started/quickstart.html).

### 1. Clone and Build the Project

```bash
git clone https://github.com/digital-asset/canton-privacy-amm.git
cd canton-privacy-amm
dpm build
```

### 2. Start a Local Canton Ledger

This command starts a local Canton sandbox environment with a running JSON API server on port `7575`.

```bash
dpm sandbox
```

### 3. Run the Setup Script

In a separate terminal, run the `Setup` script. This script uses Daml Script to initialize the ledger with the necessary parties and contracts:
*   Allocates parties: `AmmOperator`, `Alice` (an LP), and `Bob` (a trader).
*   Deploys the main `Factory` contract, controlled by the `AmmOperator`.
*   Creates a sample `USDC`/`wETH` token pair and a corresponding `Pool` contract with a 0.30% fee tier.

```bash
dpm test --files daml/Test/Setup.daml
```

### 4. Provide Liquidity

As an LP (`Alice`), you can now create a shielded liquidity position. The following Daml Script snippet demonstrates how to add `$10,000` of liquidity to the `USDC`/`wETH` pool between the price ticks of `-100` and `100`.

You can run this directly or adapt it into a JSON API call.

**File: `daml/Test/LpActions.daml`**
```daml
module Test.LpActions where

import Daml.Script
import Main.Factory
import Main.Pool

-- Add this script to a test file to run it
addLiquidityScript : Script ()
addLiquidityScript = script do
  -- 1. Get allocated parties from the setup script
  operator <- partyFromName "AmmOperator"
  alice <- partyFromName "Alice"

  -- 2. Find the USDC/wETH 0.30% pool created in the setup
  (poolCid, pool) <- querySingle @Pool alice

  -- 3. Submit the command to create a new liquidity position
  submit alice do
    exerciseCmd poolCid CreateLpPosition with
      lp = alice
      lowerTick = -100
      upperTick = 100
      amount = 10000.0
  
  return ()
```

Run the script:
```bash
dpm test --files daml/Test/LpActions.daml
```
After this runs, a new `LpPosition` contract exists on the ledger, but it is only visible to `Alice` and the `AmmOperator`.

### 5. Remove Liquidity

To withdraw liquidity and collect accrued fees, `Alice` exercises the `RemoveLpPosition` choice on her `LpPosition` contract. This will archive the contract and transfer the underlying assets plus any earned fees back to her.

## Project Structure

*   `daml/Main/`: Main Daml modules for the AMM.
    *   `Factory.daml`: Singleton contract for creating and tracking pools.
    *   `Pool.daml`: The core AMM logic for a single asset pair and fee tier. Manages swaps and liquidity positions.
    *   `Position.daml`: Defines the `LpPosition` template, representing a single shielded liquidity position.
    *   `Types.daml`: Common data types used across the project (e.g., `Token`, `Tick`).
    *   `Math/*.daml`: Library files for handling tick math and square root price calculations.
*   `daml/Test/`: Daml Script files for testing, setup, and demonstrating workflows.
*   `daml.yaml`: The DPM project configuration file.

## Development & Testing

To run all included tests:

```bash
dpm test
```

## License

This project is licensed under the [Apache 2.0 License](LICENSE).