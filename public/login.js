document.getElementById("loginBtn").addEventListener("click", async (e) => {
    e.preventDefault();

    const username = document.getElementById("USER").value.trim();
    const password = document.getElementById("PASSWORD").value.trim();

    if (!username || !password) {
        alert("Please enter both username and password.");
        return;
    }

    try {
        const response = await fetch("/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });

        const result = await response.json();

        if (response.ok) {
            alert(result.message);
            // THIS LINE REDIRECTS TO INDEX.HTML ONLY ON SUCCESSFUL LOGIN
            window.location.href = "index.html"; 
        } else {
            alert(result.error || result.message || "Login failed");
        }

    } catch (error) {
        console.error("Fetch failed:", error);
        alert("Fetch failed: " + error.message + ". Please ensure the server is running.");
    }
});