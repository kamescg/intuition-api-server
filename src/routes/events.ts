import {
  sync,
  search,
  createAtomFromIpfsUri,
  createAtomFromString,
  createTripleStatement,
  calculateAtomId,
  calculateTripleId,
  uploadJsonToPinata,
  getTripleCost,
  getAtomCost,
  MultiVaultAbi,
} from "@0xintuition/sdk";
import { toHex, type Hex } from "viem";
import { Request, Response, Router, text } from "express";
import { validateApiKey } from "../middleware/auth.js";
import { intuitionConfig, account, pinataApiToken } from "../setup.js";
import { flattenToOneLevel, normalizeFlatValues, isAlreadyExistsError } from "../utils.js";
import {
  IntuitionEvent,
  QuizCompletedEvent,
  validateEvent,
} from "../types/events.js";

// Thing interface for the core atom fields
interface ThingData {
  name: string;
  description: string;
  url: string;
  image: string;
}

// Request body for v1/intuition route
interface IntuitionSyncRequest {
  thing: ThingData;
  metadata?: Record<string, unknown>;
}

// Constant predicate for metadata triples
const METADATA_PREDICATE = "metadata";

// Helper to check if a term (atom or triple) exists on-chain
async function isTermCreated(termId: Hex): Promise<boolean> {
  const { publicClient, address } = intuitionConfig;
  return await publicClient.readContract({
    address,
    abi: MultiVaultAbi,
    functionName: "isTermCreated",
    args: [termId],
  });
}

// Helper to get or create the metadata predicate atom
async function getOrCreateMetadataPredicateAtom(): Promise<Hex> {
  const predicateData = toHex(METADATA_PREDICATE);
  const predicateAtomId = calculateAtomId(predicateData);

  const exists = await isTermCreated(predicateAtomId);
  if (!exists) {
    console.log("Creating metadata predicate atom...");
    await createAtomFromString(intuitionConfig, METADATA_PREDICATE);
    console.log("Metadata predicate atom created:", predicateAtomId);
  } else {
    console.log("Metadata predicate atom already exists:", predicateAtomId);
  }

  return predicateAtomId;
}

const router = Router();

// Webhook endpoint (for external integrations)
// Protected with API key authentication
router.post(
  "/v1/intuition/events",
  validateApiKey,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const event = req.body as IntuitionEvent;

      // Log the incoming POST data
      console.log("========================================");
      console.log("Webhook received at:", new Date().toISOString());
      console.log("Event Type:", event.type);
      console.log("Body:", JSON.stringify(req.body, null, 2));
      console.log("========================================");

      // Validate event structure
      const validation = validateEvent(event);
      if (!validation.valid) {
        console.error("Validation failed:", validation.error);
        res.status(400).json({
          success: false,
          error: "Invalid event structure",
          message: validation.error,
        });
        return;
      }

      // Handle different event types
      switch (event.type) {
        case "quiz_completed":
          await handleQuizCompletedEvent(event);
          break;

        default:
          res.status(400).json({
            success: false,
            error: "Unknown event type",
            message: `Event type "${event.type}" is not supported`,
          });
          return;
      }

      // Send success response
      res.status(200).json({
        success: true,
        message: `Event '${event.type}' received and processed`,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error("Webhook error:", error);
      res.status(500).json({
        success: false,
        error: "Webhook processing failed",
        message: error.message || "Unknown error occurred",
      });
    }
  }
);

// Handler for quiz_completed events
async function handleQuizCompletedEvent(event: QuizCompletedEvent) {
  console.log("Processing quiz_completed event:");
  console.log("  User Address:", event.userAddress);
  console.log("  Community ID:", event.communityId);
  console.log("  Quiz ID:", event.metadata.quizId);
  console.log("  Completed At:", event.metadata.completedAt);
  console.log("  Version:", event.version);

  // Transform event data into Intuition protocol format
  // Use user address as the DID
  const did = `did:eth:${event.userAddress.toLowerCase()}`;

  const syncData = {
    [did]: {
      type: "quiz_completion",
      "https://schema.org/keywords": "ipfs://QmRp1abVgPBgN5dSVfRsSpUWa8gUz5PhmSJMCLCSqDpvSP",
      user_address: event.userAddress,
      community_id: event.communityId,
      quiz_id: event.metadata.quizId,
      completed_at: event.metadata.completedAt,
      event_version: event.version,
    },
  };

  console.log("Syncing to blockchain...");
  console.log("  DID:", did);
  console.log("  Data:", JSON.stringify(syncData, null, 2));

  try {
    await sync(intuitionConfig, syncData);
    console.log("✅ Successfully synced to blockchain");
  } catch (error: any) {
    if (isAlreadyExistsError(error)) {
      console.log("ℹ️ Idempotent no-op: data already exists; treating as success");
      return;
    }
    console.error("❌ Failed to sync to blockchain:", error?.message || error);
    throw error; // Re-throw to be caught by the main handler
  }
}

export default router;

// New endpoint: POST /v1/intuition/
// Accepts a Thing object (name, description, url, image) and optional metadata.
// Flow:
// 1. Upload thing to IPFS -> get uriRef
// 2. Check if thing atom exists on-chain
// 3. If not, create thing atom
// 4. Upload metadata to IPFS -> get uriRef
// 5. Check if metadata atom exists on-chain
// 6. If not, create metadata atom
// 7. Create triple (thing -> metadata predicate -> metadata atom)
// Always returns the IDs for thing, metadata, and triple
router.post(
  "/v1/intuition/",
  validateApiKey,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const payload = req.body as unknown;

      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        res.status(400).json({
          success: false,
          error: "Invalid payload",
          message: "Expected a JSON object with 'thing' field",
        });
        return;
      }

      const body = payload as IntuitionSyncRequest;

      // Validate thing object
      if (!body.thing || typeof body.thing !== "object") {
        res.status(400).json({
          success: false,
          error: "Missing thing",
          message: "Request must include a 'thing' object with name, description, url, and image",
        });
        return;
      }

      const { name, description, url, image } = body.thing;

      // Validate required Thing fields
      if (!name || typeof name !== "string") {
        res.status(400).json({
          success: false,
          error: "Invalid thing",
          message: "thing.name is required and must be a string",
        });
        return;
      }
      if (!description || typeof description !== "string") {
        res.status(400).json({
          success: false,
          error: "Invalid thing",
          message: "thing.description is required and must be a string",
        });
        return;
      }
      if (!url || typeof url !== "string") {
        res.status(400).json({
          success: false,
          error: "Invalid thing",
          message: "thing.url is required and must be a string",
        });
        return;
      }
      if (!image || typeof image !== "string") {
        res.status(400).json({
          success: false,
          error: "Invalid thing",
          message: "thing.image is required and must be a string",
        });
        return;
      }

      // Require Pinata API token for all operations (thing + metadata go to IPFS)
      if (!pinataApiToken) {
        res.status(500).json({
          success: false,
          error: "IPFS not configured",
          message: "PINATA_API_JWT must be set to upload data",
        });
        return;
      }

      console.log("========================================");
      console.log("Processing Thing + Metadata sync");
      console.log("========================================");

      // ================================================================
      // Step 1: Upload thing to IPFS (using schema.org JSON-LD format)
      // ================================================================
      console.log("Step 1: Uploading thing to IPFS...");
      const thingData = {
        "@context": "https://schema.org",
        "@type": "Thing",
        name,
        description,
        url,
        image,
      };
      const thingUpload = await uploadJsonToPinata(pinataApiToken, thingData);
      const thingIpfsUri = `ipfs://${thingUpload.IpfsHash}` as `ipfs://${string}`;
      console.log("  Thing IPFS URI:", thingIpfsUri);

      // ================================================================
      // Step 2: Check if thing atom exists on-chain
      // ================================================================
      console.log("Step 2: Checking if thing atom exists...");
      const thingAtomData = toHex(thingIpfsUri);
      const thingAtomId = calculateAtomId(thingAtomData);
      const thingAtomExists = await isTermCreated(thingAtomId);
      console.log("  Thing Atom ID:", thingAtomId);
      console.log("  Exists:", thingAtomExists);

      // ================================================================
      // Step 3: Create thing atom if it doesn't exist
      // ================================================================
      let thingAtomCreated = false;
      if (!thingAtomExists) {
        console.log("Step 3: Creating thing atom...");
        await createAtomFromIpfsUri(intuitionConfig, thingIpfsUri);
        thingAtomCreated = true;
        console.log("  Thing atom created");
      } else {
        console.log("Step 3: Thing atom already exists, skipping creation");
      }

      // ================================================================
      // Step 4: Upload metadata to IPFS (if provided)
      // ================================================================
      let metadataAtomId: Hex | null = null;
      let metadataIpfsUri: string | null = null;
      let tripleId: Hex | null = null;

      if (body.metadata && Object.keys(body.metadata).length > 0) {
        console.log("Step 4: Uploading metadata to IPFS...");
        const metadataUpload = await uploadJsonToPinata(pinataApiToken, body.metadata);
        metadataIpfsUri = `ipfs://${metadataUpload.IpfsHash}`;
        console.log("  Metadata IPFS URI:", metadataIpfsUri);

        // ================================================================
        // Step 5: Check if metadata atom exists on-chain
        // ================================================================
        console.log("Step 5: Checking if metadata atom exists...");
        const metadataAtomData = toHex(metadataIpfsUri);
        metadataAtomId = calculateAtomId(metadataAtomData);
        const metadataAtomExists = await isTermCreated(metadataAtomId);
        console.log("  Metadata Atom ID:", metadataAtomId);
        console.log("  Exists:", metadataAtomExists);

        // ================================================================
        // Step 6: Create metadata atom if it doesn't exist
        // ================================================================
        if (!metadataAtomExists) {
          console.log("Step 6: Creating metadata atom...");
          await createAtomFromIpfsUri(intuitionConfig, metadataIpfsUri as `ipfs://${string}`);
          console.log("  Metadata atom created");
        } else {
          console.log("Step 6: Metadata atom already exists, skipping creation");
        }

        // ================================================================
        // Step 7: Get or create metadata predicate atom, then create triple
        // ================================================================
        console.log("Step 7: Getting/creating metadata predicate atom...");
        const predicateAtomId = await getOrCreateMetadataPredicateAtom();

        // Calculate triple ID
        tripleId = calculateTripleId(thingAtomId, predicateAtomId, metadataAtomId);
        console.log("  Triple ID:", tripleId);

        // Check if triple exists
        const tripleExists = await isTermCreated(tripleId);
        console.log("  Triple exists:", tripleExists);

        if (!tripleExists) {
          console.log("  Creating triple...");
          // Get triple cost for the transaction value
          const tripleCost = await getTripleCost({
            publicClient: intuitionConfig.publicClient,
            address: intuitionConfig.address,
          });

          await createTripleStatement(intuitionConfig, {
            args: [[thingAtomId], [predicateAtomId], [metadataAtomId], [tripleCost]],
            value: tripleCost,
          });

          const normalized: Record<string, string | string[]> = normalizeFlatValues(body.metadata);
          const syncData: Record<string, Record<string, string | string[]>> = {
            [thingIpfsUri]: normalized,
          };

    
          const data = await sync(intuitionConfig, syncData);
          console.log("  Triple created", data);
        } else {
          console.log("  Triple already exists, skipping creation");
        }
      }

      console.log("========================================");
      console.log("Sync complete!");
      console.log("========================================");

      // Always return all the IDs
      res.status(200).json({
        success: true,
        message: metadataAtomId
          ? "Thing and metadata synced to Intuition"
          : "Thing synced to Intuition",
        thingAtomId,
        thingIpfsUri,
        thingAtomCreated,
        ...(metadataAtomId && {
          metadataAtomId,
          metadataIpfsUri,
          tripleId,
        }),
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error("Intuition sync error:", error);
      res.status(500).json({
        success: false,
        error: "Sync failed",
        message: error.message || "Unknown error occurred",
      });
    }
  }
);

// New endpoint: POST /v1/intuition/agent
// Body: { url: string } → fetches JSON from the URL, flattens with ':' joiner,
// and syncs under the DID derived from SIGNER (account.address)
router.post(
  "/v1/intuition/agent",
  // Allow raw string bodies (text/plain) for direct URL payloads
  text({ type: "text/plain" }),
  validateApiKey,
  async (req: Request, res: Response): Promise<void> => {
    try {
      let url: string | undefined;
      if (typeof (req.body as any) === "string") {
        const candidate = (req.body as string).trim();
        try {
          // Validate URL format
          // eslint-disable-next-line no-new
          new URL(candidate);
          url = candidate;
        } catch {
          res.status(400).json({
            success: false,
            error: "Invalid URL",
            message: "When sending a raw string body, it must be a valid URL",
          });
          return;
        }
      } else {
        const body = (req.body as any) ?? {};
        url = typeof body?.url === "string" ? body.url : undefined;
        if (!url) {
          res.status(400).json({
            success: false,
            error: "Invalid payload",
            message: "Expected JSON body: { url: string } or raw text/plain URL",
          });
          return;
        }
      }

      // Fetch JSON from the provided URL with a simple timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let response;
      try {
        response = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: controller.signal as AbortSignal,
        } as any);
      } finally {
        clearTimeout(timeout);
      }

      if (!response || !("ok" in response) || !(response as any).ok) {
        const status = (response as any)?.status ?? 502;
        const statusText = (response as any)?.statusText ?? "Bad Gateway";
        res.status(502).json({
          success: false,
          error: "Upstream fetch failed",
          message: `Failed to fetch ${url}: ${status} ${statusText}`,
        });
        return;
      }

      // Try to parse JSON regardless of content-type; surface parse errors cleanly
      let data: unknown;
      try {
        data = await (response as any).json();
      } catch (e: any) {
        res.status(415).json({
          success: false,
          error: "Invalid upstream content",
          message: `Expected JSON from URL but could not parse: ${e?.message || e}`,
        });
        return;
      }

      if (!data || typeof data !== "object") {
        res.status(415).json({
          success: false,
          error: "Unsupported upstream data",
          message: "Fetched payload is not a JSON object",
        });
        return;
      }

      const flatData = flattenToOneLevel(data);
      // Inject required tag for agent entries
      (flatData as Record<string, unknown>)["has tag"] = "AI Agent";
      if (Object.keys(flatData).length === 0) {
        res.status(400).json({
          success: false,
          error: "Empty data",
          message: "Fetched JSON did not contain any usable key/value pairs",
        });
        return;
      }

      const did = `did:eth:${account.address.toLowerCase()}`;
      const normalized: Record<string, string | string[]> = normalizeFlatValues(flatData);
      const syncData: Record<string, Record<string, string | string[]>> = {
        [did]: normalized,
      };

      console.log("Syncing agent data from URL to blockchain...");
      console.log("  Source URL:", url);
      console.log("  DID:", did);
      console.log("  Data:", JSON.stringify(syncData, null, 2));

      try {
        await sync(intuitionConfig, syncData);
        res.status(200).json({
          success: true,
          message: "Agent data fetched and synced",
          did,
          keys: Object.keys(flatData).length,
          source: url,
          timestamp: new Date().toISOString(),
        });
        return;
      } catch (error: any) {
        if (isAlreadyExistsError(error)) {
          res.status(200).json({
            success: true,
            message: "Idempotent no-op: data already exists",
            did,
            keys: Object.keys(flatData).length,
            source: url,
            timestamp: new Date().toISOString(),
          });
          return;
        }
        throw error;
      }
    } catch (error: any) {
      const aborted = error?.name === "AbortError";
      console.error("Agent URL sync error:", error);
      res.status(aborted ? 504 : 500).json({
        success: false,
        error: aborted ? "Upstream timeout" : "Sync failed",
        message: error.message || "Unknown error occurred",
      });
    }
  }
);

// New endpoint: POST /v1/intuition/search
// Body: arbitrary JSON object → flattened with ':' joiner and used as search criteria.
// Special case: { URL: string } or { url: string } → fetch JSON first, then proceed.
router.post(
  "/v1/intuition/search",
  // Allow raw string bodies (text/plain) for direct URL payloads
  text({ type: "text/plain" }),
  validateApiKey,
  async (req: Request, res: Response): Promise<void> => {
    try {
      let payload: unknown = (req.body as any) ?? undefined;

      // If body is a raw string, treat it as a URL
      if (typeof payload === "string") {
        const urlString = payload.trim();
        try {
          // Validate URL format
          // eslint-disable-next-line no-new
          new URL(urlString);
        } catch {
          res.status(400).json({
            success: false,
            error: "Invalid URL",
            message: "When sending a raw string body, it must be a valid URL",
          });
          return;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let response;
        try {
          response = await fetch(urlString, {
            headers: { Accept: "application/json" },
            signal: controller.signal as AbortSignal,
          } as any);
        } finally {
          clearTimeout(timeout);
        }
        if (!response || !("ok" in response) || !(response as any).ok) {
          const status = (response as any)?.status ?? 502;
          const statusText = (response as any)?.statusText ?? "Bad Gateway";
          res.status(502).json({
            success: false,
            error: "Upstream fetch failed",
            message: `Failed to fetch ${urlString}: ${status} ${statusText}`,
          });
          return;
        }
        try {
          payload = await (response as any).json();
        } catch (e: any) {
          res.status(415).json({
            success: false,
            error: "Invalid upstream content",
            message: `Expected JSON from URL but could not parse: ${e?.message || e}`,
          });
          return;
        }
      }

      // If only { URL: ... } (or { url: ... }), fetch JSON from the URL
      if (
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        Object.keys(payload as Record<string, unknown>).length === 1
      ) {
        const onlyKey = Object.keys(payload as Record<string, unknown>)[0];
        if (onlyKey === "URL" || onlyKey === "url") {
          const url = (payload as any)[onlyKey];
          if (!url || typeof url !== "string") {
            res.status(400).json({
              success: false,
              error: "Invalid payload",
              message: "URL value must be a string",
            });
            return;
          }
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          let response;
          try {
            response = await fetch(url, {
              headers: { Accept: "application/json" },
              signal: controller.signal as AbortSignal,
            } as any);
          } finally {
            clearTimeout(timeout);
          }
          if (!response || !("ok" in response) || !(response as any).ok) {
            const status = (response as any)?.status ?? 502;
            const statusText = (response as any)?.statusText ?? "Bad Gateway";
            res.status(502).json({
              success: false,
              error: "Upstream fetch failed",
              message: `Failed to fetch ${url}: ${status} ${statusText}`,
            });
            return;
          }
          try {
            payload = await (response as any).json();
          } catch (e: any) {
            res.status(415).json({
              success: false,
              error: "Invalid upstream content",
              message: `Expected JSON from URL but could not parse: ${e?.message || e}`,
            });
            return;
          }
        }
      }

      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        res.status(400).json({
          success: false,
          error: "Invalid payload",
          message: "Expected a JSON object with key/value pairs",
        });
        return;
      }

      const flatData = flattenToOneLevel(payload);
      const criteria = toSearchCriteria(flatData);

      if (criteria.length === 0) {
        res.status(400).json({
          success: false,
          error: "Empty criteria",
          message: "No usable key/value pairs for search",
        });
        return;
      }

      console.log("Performing search with criteria:", criteria);
      const trusted = [account.address];
      const result = await search(criteria as any, trusted);

      res.status(200).json({
        success: true,
        count: Array.isArray((result as any)?.results)
          ? (result as any).results.length
          : undefined,
        criteria,
        trusted,
        result,
      });
    } catch (error: any) {
      console.error("Search endpoint error:", error);
      res.status(500).json({
        success: false,
        error: "Search failed",
        message: error?.message || "Unknown error",
      });
    }
  }
);

// Convert flat key/value map into Intuition SDK search criteria array.
// Values become strings; for arrays, emit multiple criteria entries for the same key.
function toSearchCriteria(
  flat: Record<string, unknown>
): Array<Record<string, string>> {
  const criteria: Array<Record<string, string>> = [];
  for (const [k, v] of Object.entries(flat)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item == null) continue;
        const val = typeof item === "string" ? item : String(item);
        criteria.push({ [k]: val });
      }
    } else {
      const val = typeof v === "string" ? v : String(v);
      criteria.push({ [k]: val });
    }
  }
  return criteria;
}
