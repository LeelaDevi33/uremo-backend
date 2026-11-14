module.exports = function retiredCatalog(_req, res) {
  res.status(410).json({
    ok: false,
    code: "SERVICE_CATALOG_RETIRED",
    message: "New listings and purchases have moved to project opportunities.",
    marketplace: "/api/opportunities",
  });
};
