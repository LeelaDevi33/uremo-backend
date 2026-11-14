const { baseUrl: BASE_URL, email, password, testFetch } = require("./admin-test-config");

async function test() {
  console.log("Testing admin workspace routes...\n");

  try {
    const loginRes = await testFetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const loginData = await loginRes.json();
    console.log("Status:", loginRes.status);


    if (loginData.token) {
      console.log("\n✅ LOGIN SUCCESS");

      console.log("Role:", loginData.user?.role);

      // Now test creating a service
      console.log("\n--- Creating Test Service ---");
      const createRes = await testFetch(`${BASE_URL}/api/admin/services`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${loginData.token}`,
        },
        body: JSON.stringify({
          title: "Outlier Math Expert Support (Test P21)",
          category: "microjobs",
          subcategory: "fresh_account",
          description: "Test service for PATCH21 validation",
          price: 35,
          platform: "Outlier",
          subject: "Math",
          countries: ["India", "USA"],
          status: "active",
        }),
      });

      const createData = await createRes.json();
      console.log("Create Status:", createRes.status);
      console.log("Create Result:", JSON.stringify(createData, null, 2));

      if (createData.service?._id) {
        console.log("\n✅ SERVICE CREATED:", createData.service._id);

        // Test edit
        console.log("\n--- Editing Service ---");
        const editRes = await testFetch(
          `${BASE_URL}/api/admin/services/${createData.service._id}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${loginData.token}`,
            },
            body: JSON.stringify({
              price: 40,
              shortDescription: "Updated test",
            }),
          },
        );

        const editData = await editRes.json();
        console.log("Edit Status:", editRes.status);
        console.log("Edit OK:", editData.ok);
      }

      // Test JarvisX admin chat
      console.log("\n--- Testing JarvisX Admin ---");
      const jarvisRes = await testFetch(`${BASE_URL}/api/jarvisx/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${loginData.token}`,
        },
        body: JSON.stringify({ message: "show me all services" }),
      });

      const jarvisData = await jarvisRes.json();
      console.log("JarvisX Status:", jarvisRes.status);
      console.log("JarvisX Intent:", jarvisData.intent);
      console.log("JarvisX Reply:", (jarvisData.reply || "").substring(0, 200));
    } else {
      console.log("\n❌ LOGIN FAILED");
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

test();
