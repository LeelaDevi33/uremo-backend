// Historical entry point: do not turn an application role into a paid project.
const guidance = "Role-to-offer import is retired. Keep open roles as free specializations. " +
  "Create a real project under the role, then choose Rent or Full Access in Admin → Project offers. " +
  "For a read-only legacy inventory use: node scripts/review-project-offers.js --db LOCAL_DATABASE --port 27347";
if (process.argv.length === 3 && process.argv[2] === "--help") console.log(guidance);
else { console.error(guidance); process.exitCode = 1; }
