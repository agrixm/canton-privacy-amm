/**
 * @module AmmClient
 *
 * A TypeScript SDK for interacting with the Canton Privacy AMM smart contracts.
 * This client provides methods for querying liquidity pool state and executing atomic swaps
 * against the Canton ledger's JSON API.
 *
 * It handles the precise calculations required for the constant-product formula (x*y=k)
 * using BigInt to avoid floating-point inaccuracies, which is critical for financial applications.
 *
 * @example
 * ```typescript
 * import { AmmClient, TokenIdentifier } from './ammClient';
 *
 * const LEDGER_URL = 'http://localhost:7575';
 * // The partyId needs to be KYC-cleared to interact with the AMM.
 * const PARTY_ID = 'your-kyc-cleared-party-id';
 * const JWT = 'your-ledger-api-jwt';
 *
 * const client = new AmmClient(LEDGER_URL, PARTY_ID, JWT);
 *
 * async function run() {
 *   console.log("Fetching available liquidity pools...");
 *   const pools = await client.getPools();
 *   if (pools.length === 0) {
 *     console.log("No liquidity pools found.");
 *     return;
 *   }
 *   console.log(`Found ${pools.length} pool(s).`);
 *   const pool = pools[0];
 *   const { tokenA, tokenB, reserveA, reserveB, fee } = pool.payload;
 *
 *   console.log(`Pool ${pool.contractId}:`);
 *   console.log(`  - ${tokenA.symbol}: ${reserveA}`);
 *   console.log(`  - ${tokenB.symbol}: ${reserveB}`);
 *   console.log(`  - Fee: ${fee}`);
 *
 *   const amountIn = "100.0000000000"; // Amount of Token A to swap
 *   const calculatedAmountOut = AmmClient.calculateSwapOutput(reserveA, reserveB, amountIn, fee);
 *   console.log(`Swapping ${amountIn} ${tokenA.symbol} would yield approximately ${calculatedAmountOut} ${tokenB.symbol}`);
 *
 *   try {
 *     console.log("Executing swap...");
 *     const result = await client.swap(
 *       pool.contractId,
 *       tokenA,
 *       amountIn,
 *       "0.0" // No slippage protection for this example
 *     );
 *     console.log(`Swap successful! Transaction ID: ${result.transactionId}`);
 *     console.log(`Received ${result.amountOut} ${tokenB.symbol}`);
 *   } catch (error) {
 *     console.error("Swap failed:", error);
 *   }
 * }
 *
 * run().catch(console.error);
 * ```
 */

// --- Type Definitions ---

export type Party = string;
export type ContractId = string;
/** A string representation of a 10-decimal place number, e.g., "123.4560000000" */
export type Decimal = string;

/** Uniquely identifies a token type on the ledger. */
export interface TokenIdentifier {
  issuer: Party;
  symbol: string;
}

/** Represents an active LiquidityPool contract on the ledger. */
export interface LiquidityPool {
  contractId: ContractId;
  templateId: string;
  payload: {
    operator: Party;
    tokenA: TokenIdentifier;
    tokenB: TokenIdentifier;
    reserveA: Decimal;
    reserveB: Decimal;
    lpTokenSymbol: string;
    /** The swap fee as a decimal, e.g., "0.0030000000" for 0.3%. */
    fee: Decimal;
  };
}

/** The result of a successful swap operation. */
export interface SwapResult {
  /** The amount of the output token received from the swap. */
  amountOut: Decimal;
  /** The ID of the ledger transaction that executed the swap. */
  transactionId: string;
}

// --- Internal Helpers for Decimal Math ---

const DAML_DECIMAL_PLACES = 10;
const DAML_DECIMAL_SCALE = 10n ** BigInt(DAML_DECIMAL_PLACES);

/** Converts a Daml Decimal string to a scaled BigInt for precise calculations. */
const damlDecimalToBigInt = (decimal: Decimal): bigint => {
  const [whole, fraction = ''] = decimal.split('.');
  const paddedFraction = fraction.padEnd(DAML_DECIMAL_PLACES, '0').slice(0, DAML_DECIMAL_PLACES);
  return BigInt(whole + paddedFraction);
};

/** Converts a scaled BigInt back to a Daml Decimal string. */
const bigIntToDamlDecimal = (value: bigint): Decimal => {
  const s = (value < 0 ? -value : value).toString();
  const len = s.length;
  let whole: string;
  let fraction: string;

  if (len <= DAML_DECIMAL_PLACES) {
    whole = '0';
    fraction = s.padStart(DAML_DECIMAL_PLACES, '0');
  } else {
    whole = s.slice(0, len - DAML_DECIMAL_PLACES);
    fraction = s.slice(len - DAML_DECIMAL_PLACES);
  }
  return (value < 0 ? '-' : '') + `${whole}.${fraction}`;
};

// --- AMM Client ---

export class AmmClient {
  private readonly ledgerUrl: string;
  private readonly partyId: Party;
  private readonly headers: HeadersInit;
  // Assumes the Daml module is named AMM.Pool and the template is LiquidityPool
  private readonly POOL_TEMPLATE_ID = 'AMM.Pool:LiquidityPool';

  /**
   * Constructs a new AmmClient.
   * @param ledgerUrl The base URL of the Canton ledger's JSON API (e.g., "http://localhost:7575").
   * @param partyId The Daml Party ID of the user interacting with the AMM.
   * @param token A JWT for authenticating with the JSON API.
   */
  constructor(ledgerUrl: string, partyId: Party, token: string) {
    this.ledgerUrl = ledgerUrl.endsWith('/') ? ledgerUrl.slice(0, -1) : ledgerUrl;
    this.partyId = partyId;
    this.headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * A private helper to make authenticated requests to the JSON API.
   * @param endpoint The API endpoint (e.g., "/v1/query").
   * @param options The standard fetch RequestInit options.
   * @returns The JSON response from the API.
   */
  private async makeRequest<T>(endpoint: string, options: RequestInit): Promise<T> {
    const url = `${this.ledgerUrl}${endpoint}`;
    const response = await fetch(url, { ...options, headers: this.headers });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ledger API request failed: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const json = await response.json();

    // Handle Canton's enveloped error responses (HTTP 200 with an error payload)
    if (json.status && json.status !== 200) {
      throw new Error(`Ledger API Error: ${JSON.stringify(json.errors || json)}`);
    }

    return json as T;
  }

  /**
   * Fetches all active liquidity pool contracts visible to the client's party.
   * @returns A promise that resolves to an array of LiquidityPool contracts.
   */
  public async getPools(): Promise<LiquidityPool[]> {
    const body = {
      templateIds: [this.POOL_TEMPLATE_ID],
    };
    const response = await this.makeRequest<{ result: LiquidityPool[] }>('/v1/query', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.result;
  }

  /**
   * Fetches a single active liquidity pool contract by its contract ID.
   * @param contractId The ID of the contract to fetch.
   * @returns A promise that resolves to the LiquidityPool contract or null if not found/visible.
   */
  public async getPool(contractId: ContractId): Promise<LiquidityPool | null> {
    try {
      const response = await this.makeRequest<{ result: LiquidityPool }>(
        `/v1/contracts/${encodeURIComponent(contractId)}`,
        { method: 'GET' }
      );
      return response.result;
    } catch (error) {
      // The API returns a 404 which our helper turns into an error.
      // We can interpret this as the contract not being found or visible.
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Executes a swap on a specified liquidity pool.
   * @param poolCid The contract ID of the LiquidityPool to swap against.
   * @param tokenIn The identifier of the token being sold.
   * @param amountIn The amount of the token being sold.
   * @param minAmountOut The minimum amount of the output token to accept, for slippage protection.
   * @returns A promise that resolves to a SwapResult upon successful execution.
   */
  public async swap(
    poolCid: ContractId,
    tokenIn: TokenIdentifier,
    amountIn: Decimal,
    minAmountOut: Decimal
  ): Promise<SwapResult> {
    const body = {
      templateId: this.POOL_TEMPLATE_ID,
      contractId: poolCid,
      choice: 'Swap',
      argument: {
        trader: this.partyId,
        tokenIn: tokenIn,
        amountIn: amountIn,
        minAmountOut: minAmountOut,
      },
    };

    const response = await this.makeRequest<{ result: { exerciseResult: Decimal, transactionId: string } }>('/v1/exercise', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return {
      amountOut: response.result.exerciseResult,
      transactionId: response.result.transactionId,
    };
  }

  /**
   * Calculates the expected output amount for a swap without executing it.
   * This is a pure function that can be used for UI estimations.
   * The formula is: amountOut = (reserveOut * amountIn * (1 - fee)) / (reserveIn + amountIn)
   * @param reserveIn The reserve of the token being sold.
   * @param reserveOut The reserve of the token being bought.
   * @param amountIn The amount of the token being sold.
   * @param fee The pool's swap fee (e.g., "0.0030000000").
   * @returns The calculated output amount as a Decimal string.
   */
  public static calculateSwapOutput(
    reserveIn: Decimal,
    reserveOut: Decimal,
    amountIn: Decimal,
    fee: Decimal
  ): Decimal {
    const reserveInBI = damlDecimalToBigInt(reserveIn);
    const reserveOutBI = damlDecimalToBigInt(reserveOut);
    const amountInBI = damlDecimalToBigInt(amountIn);
    const feeBI = damlDecimalToBigInt(fee);

    if (reserveInBI <= 0n || reserveOutBI <= 0n || amountInBI <= 0n) {
      return "0.0000000000";
    }

    const feeFactor = DAML_DECIMAL_SCALE - feeBI;

    const numerator = reserveOutBI * amountInBI * feeFactor;
    const denominator = (reserveInBI + amountInBI) * DAML_DECIMAL_SCALE;
    
    if (denominator === 0n) {
      return "0.0000000000";
    }
    
    const amountOutBI = numerator / denominator;

    return bigIntToDamlDecimal(amountOutBI);
  }
}