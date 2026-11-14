const { MongoClient } = require("mongoose").mongo;
const { connectionArgs } = require("./reconcile-wallets");
const { verifyMarketplaceIndexes } = require("../src/services/marketplaceIndexes");

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
