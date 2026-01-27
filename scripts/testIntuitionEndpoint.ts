import dotenv from "dotenv";
dotenv.config();

// =============================================================================
// CONFIGURATION - Edit these values to test different scenarios
// =============================================================================

const CONFIG = {
  // API endpoint (defaults to local server)
  apiUrl: process.env.API_URL || "http://localhost:3001",
};

// =============================================================================
// SAMPLE DATA - Edit these values to test with your own data
// =============================================================================

// Required: Core Thing data (name, description, url, image)
// Note: The API will wrap this in schema.org JSON-LD format automatically:
// { "@context": "https://schema.org", "@type": "Thing", name, description, url, image }
const THING_DATA = {
  name: "Samgent Agent",
  description: "This is an example of an agent that can be used to test the Intuition sync endpoint.",
  url: "https://example.com",
  image: "https://res.cloudinary.com/dfpwy9nyv/image/upload/v1765857637/remix/oaw5u4augbngear7hham.webp",
};

const METADATA = {
  version: "1.0.0",
  author: "OpenAndClosedAI",
  tag: ["ai-agent", "demo", "test"],
  organization: "OpenAndClosedAI",
  website: "https://closedai.com",
};

// =============================================================================
// SCRIPT - No need to edit below this line
// =============================================================================

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("Error: API_KEY environment variable is required");
  console.error("Make sure your .env file contains API_KEY=your-key");
  process.exit(1);
}

async function testIntuitionEndpoint() {
  const requestBody: { thing: typeof THING_DATA; metadata?: typeof METADATA } = {
    thing: THING_DATA,
  };

  // Only include metadata if it has values
  if (METADATA && Object.keys(METADATA).length > 0) {
    requestBody.metadata = METADATA;
  }

  console.log("=".repeat(60));
  console.log("Testing POST /v1/intuition/");
  console.log("=".repeat(60));
  console.log("");
  console.log("URL:", `${CONFIG.apiUrl}/v1/intuition/`);
  console.log("");
  console.log("Thing Data:");
  console.log(JSON.stringify(THING_DATA, null, 2));
  console.log("");
  if (requestBody.metadata) {
    console.log("Metadata:");
    console.log(JSON.stringify(METADATA, null, 2));
  } else {
    console.log("Metadata: (none)");
  }
  console.log("");
  console.log("=".repeat(60));
  console.log("Sending request...");
  console.log("=".repeat(60));
  console.log("");

  try {
    const response = await fetch(`${CONFIG.apiUrl}/v1/intuition/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();

    console.log("Response Status:", response.status);
    console.log("Response Body:");
    console.log(JSON.stringify(data, null, 2));
    console.log("");

    if (data.success) {
      console.log("=".repeat(60));
      console.log("✅ SUCCESS");
      console.log("=".repeat(60));
      if (data.thingAtomId) {
        console.log("Thing Atom ID:", data.thingAtomId);
      }
      if (data.thingIpfsUri) {
        console.log("Thing IPFS URI:", data.thingIpfsUri);
      }
      if (data.thingAtomCreated !== undefined) {
        console.log("Thing Atom Created:", data.thingAtomCreated);
      }
      if (data.metadataAtomId) {
        console.log("Metadata Atom ID:", data.metadataAtomId);
      }
      if (data.metadataIpfsUri) {
        console.log("Metadata IPFS URI:", data.metadataIpfsUri);
      }
      if (data.tripleId) {
        console.log("Triple ID:", data.tripleId);
      }
    } else {
      console.log("=".repeat(60));
      console.log("❌ FAILED");
      console.log("=".repeat(60));
      console.log("Error:", data.error);
      console.log("Message:", data.message);
    }
  } catch (error: any) {
    console.log("=".repeat(60));
    console.log("❌ REQUEST FAILED");
    console.log("=".repeat(60));
    console.error("Error:", error.message);
    process.exit(1);
  }
}

testIntuitionEndpoint();
