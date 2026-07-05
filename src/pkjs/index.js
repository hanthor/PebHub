// PebHub - PebbleKit JS (phone-side)
// Handles config page lifecycle and OAuth relay

const configUrl = "https://hanthor.github.io/PebHub/config/";

Pebble.addEventListener("ready", function () {
  console.log("PebHub pkjs ready");
});

Pebble.addEventListener("showConfiguration", function () {
  console.log("Opening config page");
  // Pass existing settings as query params
  const settings = JSON.parse(localStorage.getItem("pebhub-config") || "{}");
  const params = new URLSearchParams();
  if (settings.forge) params.set("forge", settings.forge);
  if (settings.url) params.set("url", settings.url);
  if (settings.authMethod) params.set("authMethod", settings.authMethod);
  if (settings.username) params.set("username", settings.username);
  if (settings.excludedRepos) params.set("excludedRepos", JSON.stringify(settings.excludedRepos));
  if (settings.notifTypes) params.set("notifTypes", JSON.stringify(settings.notifTypes));
  if (settings.pollInterval) params.set("pollInterval", settings.pollInterval);

  Pebble.openURL(configUrl + "?" + params.toString());
});

Pebble.addEventListener("webviewclosed", function (e) {
  if (e && e.response) {
    try {
      const config = JSON.parse(decodeURIComponent(e.response));
      console.log("Config received: " + JSON.stringify(config));

      // Save locally
      localStorage.setItem("pebhub-config", JSON.stringify(config));

      // Send settings to watch
      var dict = {};

      if (config.token) {
        dict["CONFIG_ACCOUNT_TOKEN"] = config.token;
      }
      if (config.forge) {
        dict["CONFIG_ACCOUNT_FORGE"] = config.forge;
      }
      if (config.url) {
        dict["CONFIG_ACCOUNT_URL"] = config.url;
      }
      if (config.authMethod) {
        dict["CONFIG_ACCOUNT_AUTH_METHOD"] = config.authMethod;
      }
      if (config.username) {
        dict["CONFIG_ACCOUNT_USERNAME"] = config.username;
      }
      if (config.userId) {
        dict["CONFIG_ACCOUNT_USER_ID"] = parseInt(config.userId, 10);
      }
      if (config.excludedRepos) {
        dict["CONFIG_EXCLUDED_REPOS"] = JSON.stringify(config.excludedRepos);
      }
      if (config.notifTypes) {
        dict["CONFIG_NOTIF_TYPES"] = JSON.stringify(config.notifTypes);
      }
      if (config.pollInterval) {
        dict["CONFIG_POLL_INTERVAL"] = parseInt(config.pollInterval, 10);
      }
      if (config.maxNotifications) {
        dict["CONFIG_MAX_NOTIFICATIONS"] = parseInt(config.maxNotifications, 10);
      }
      if (config.maxCiRuns) {
        dict["CONFIG_MAX_CI_RUNS"] = parseInt(config.maxCiRuns, 10);
      }

      // Send the config as a single message
      // Need to close the ready state first if it hasn't been sent
      Pebeline.sendAppMessage(dict, function () {
        console.log("Config sent to watch successfully");
      }, function (e) {
        console.log("Config send failed: " + JSON.stringify(e));
      });

      // Also send a config refresh trigger
      Pebble.sendAppMessage({ CONFIG_READY: 1 });
    } catch (err) {
      console.log("Config parse error: " + err);
    }
  }
});
