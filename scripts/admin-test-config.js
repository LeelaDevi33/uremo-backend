// Required for the admin scripts that create or edit records.
const { baseUrl, testCredentials, testFetch } = require("./test-target");
const { email, password } = testCredentials("ADMIN");
module.exports = { baseUrl, email, password, testFetch };
