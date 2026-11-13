const { isDeepStrictEqual } = require("node:util");
const { MongoClient } = require("mongoose").mongo;
const Opportunity = require("../src/models/Opportunity");
const OpportunityGrant = require("../src/models/OpportunityGrant");
const WalletTransaction = require("../src/models/WalletTransaction");
const { connectionArgs } = require("./reconcile-wallets");

// Use the driver directly. Mongoose model initialisation could create an
// absent index and mask an incomplete restore.
async function verifyMarketplaceIndexes(db) {
  const checked = [];
  for (const model of [Opportunity, OpportunityGrant, WalletTransaction]) {
    const collection = model.collection.name;
    const installed = await db.collection(collection).listIndexes().toArray();
    for (const [keys, options] of model.schema.indexes()) {
      if (!options.unique) continue;
      const matches = installed.some(index =>
        index.unique === true &&
        isDeepStrictEqual(Object.entries(index.key), Object.entries(keys)) &&
        isDeepStrictEqual(index.partialFilterExpression, options.partialFilterExpression)
      );
      if (!matches) throw Error(`Missing required unique index on ${collection} (${Object.keys(keys).join(", ")}).`);
      checked.push({ collection, keys });
    }
  }
  return checked;
}

async function main() {
  const { name, uri } = connectionArgs(process.argv.slice(2));
  const client = new MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const indexes = await verifyMarketplaceIndexes(client.db(name));
    console.log(JSON.stringify({ database: name, indexes }, null, 2));
  } finally {
    await client.close();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verifyMarketplaceIndexes };
