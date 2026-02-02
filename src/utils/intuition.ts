/**
 * Intuition Protocol Utility Functions
 *
 * Reusable functions for interacting with the Intuition Protocol:
 * - Atom creation (from IPFS URI or string)
 * - Triple creation
 * - IPFS upload + atom creation
 * - Existence checks
 */

import {
  createAtomFromIpfsUri,
  createAtomFromString,
  createTripleStatement,
  calculateAtomId,
  calculateTripleId,
  uploadJsonToPinata,
  getTripleCost,
  MultiVaultAbi,
} from "@0xintuition/sdk";
import { toHex, type Hex } from "viem";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Result from get-or-create atom operations
 */
export interface AtomResult {
  atomId: Hex;
  created: boolean;
  ipfsUri?: string;
}

/**
 * Result from get-or-create triple operations
 */
export interface TripleResult {
  tripleId: Hex;
  created: boolean;
  subjectAtomId: Hex;
  predicateAtomId: Hex;
  objectAtomId: Hex;
}

/**
 * Thing data conforming to schema.org/Thing
 */
export interface ThingData {
  name: string;
  description: string;
  url: string;
  image: string;
}

/**
 * Configuration for Intuition protocol operations
 */
export interface IntuitionUtilConfig {
  walletClient: unknown;
  publicClient: {
    readContract: (args: {
      address: Hex;
      abi: typeof MultiVaultAbi;
      functionName: string;
      args: unknown[];
    }) => Promise<boolean>;
  };
  address: Hex;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Common predicate strings used in Intuition
 */
export const PREDICATES = {
  METADATA: "metadata",
  HAS_TAG: "has tag",
  KEYWORDS: "https://schema.org/keywords",
} as const;

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Check if an atom or triple exists on-chain
 */
export async function isTermCreated(
  config: IntuitionUtilConfig,
  termId: Hex
): Promise<boolean> {
  return await config.publicClient.readContract({
    address: config.address,
    abi: MultiVaultAbi,
    functionName: "isTermCreated",
    args: [termId],
  });
}

/**
 * Get or create an atom from an IPFS URI
 * Checks if the atom exists on-chain, creates it if not
 */
export async function getOrCreateAtomFromIpfsUri(
  config: IntuitionUtilConfig,
  ipfsUri: `ipfs://${string}`
): Promise<AtomResult> {
  const atomData = toHex(ipfsUri);
  const atomId = calculateAtomId(atomData);

  const exists = await isTermCreated(config, atomId);

  if (!exists) {
    await createAtomFromIpfsUri(config as Parameters<typeof createAtomFromIpfsUri>[0], ipfsUri);
    return { atomId, created: true, ipfsUri };
  }

  return { atomId, created: false, ipfsUri };
}

/**
 * Get or create an atom from a string value
 * Useful for predicate atoms like "metadata", "has tag", etc.
 */
export async function getOrCreateAtomFromString(
  config: IntuitionUtilConfig,
  value: string
): Promise<AtomResult> {
  const atomData = toHex(value);
  const atomId = calculateAtomId(atomData);

  const exists = await isTermCreated(config, atomId);

  if (!exists) {
    await createAtomFromString(config as Parameters<typeof createAtomFromString>[0], value);
    return { atomId, created: true };
  }

  return { atomId, created: false };
}

/**
 * Get or create a triple (subject -> predicate -> object)
 * Checks if the triple exists on-chain, creates it if not
 */
export async function getOrCreateTriple(
  config: IntuitionUtilConfig,
  subjectAtomId: Hex,
  predicateAtomId: Hex,
  objectAtomId: Hex
): Promise<TripleResult> {
  const tripleId = calculateTripleId(subjectAtomId, predicateAtomId, objectAtomId);

  const exists = await isTermCreated(config, tripleId);

  if (!exists) {
    const tripleCost = await getTripleCost({
      publicClient: config.publicClient as Parameters<typeof getTripleCost>[0]["publicClient"],
      address: config.address,
    });

    await createTripleStatement(config as Parameters<typeof createTripleStatement>[0], {
      args: [[subjectAtomId], [predicateAtomId], [objectAtomId], [tripleCost]],
      value: tripleCost,
    });

    return {
      tripleId,
      created: true,
      subjectAtomId,
      predicateAtomId,
      objectAtomId,
    };
  }

  return {
    tripleId,
    created: false,
    subjectAtomId,
    predicateAtomId,
    objectAtomId,
  };
}

// ============================================================================
// Convenience Functions (IPFS + Atom in one step)
// ============================================================================

/**
 * Upload JSON data to IPFS and create an atom
 */
export async function uploadAndCreateAtom(
  config: IntuitionUtilConfig,
  pinataToken: string,
  data: Record<string, unknown>
): Promise<AtomResult> {
  const upload = await uploadJsonToPinata(pinataToken, data);
  const ipfsUri = `ipfs://${upload.IpfsHash}` as `ipfs://${string}`;

  return getOrCreateAtomFromIpfsUri(config, ipfsUri);
}

/**
 * Upload a Thing (schema.org format) to IPFS and create an atom
 */
export async function uploadThingAndCreateAtom(
  config: IntuitionUtilConfig,
  pinataToken: string,
  thing: ThingData
): Promise<AtomResult> {
  const thingData = {
    "@context": "https://schema.org",
    "@type": "Thing",
    name: thing.name,
    description: thing.description,
    url: thing.url,
    image: thing.image,
  };

  return uploadAndCreateAtom(config, pinataToken, thingData);
}
