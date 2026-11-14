const { isDeepStrictEqual } = require("node:util");
const models = [
  require("../models/User"),
  require("../models/Opportunity"),
  require("../models/OpportunityGrant"),
  require("../models/WalletTransaction"),
  require("../models/WithdrawalRequest"),
];

async function verifyMarketplaceIndexes(db) {
  const checked = [];
  for (const model of models) {
    const collection = model.collection.name;
    const installed = await db.collection(collection).listIndexes().toArray();
    for (const [keys, options] of model.schema.indexes()) {
      if (!options.unique) continue;
      const matches = installed.some(index =>
        index.unique === true && Boolean(index.sparse) === Boolean(options.sparse) &&
        isDeepStrictEqual(Object.entries(index.key), Object.entries(keys)) &&
        isDeepStrictEqual(index.partialFilterExpression, options.partialFilterExpression)
      );
      if (!matches) throw Error(`Missing required unique index on ${collection} (${Object.keys(keys).join(", ")}).`);
      checked.push({ collection, keys });
    }
  }
  return checked;
}

async function initializeMarketplaceIndexes(db) {
  await Promise.all(models.map(model => model.init()));
  await verifyMarketplaceIndexes(db);
}

module.exports = { verifyMarketplaceIndexes, initializeMarketplaceIndexes };
