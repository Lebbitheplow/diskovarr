const client = require('./client');
const library = require('./library');
const userData = require('./userData');

// Library, then every user's history — what boot and a connection save run.
// The resync fires library.onResynced itself; history imported afterwards
// changes what each user has watched, so recommendation caches built in
// between are dropped once more.
async function syncLibraryAndUsers() {
  await library.resyncAll();
  const n = await userData.syncAllUsers();
  if (n) {
    require('../recommender').invalidateAllCaches();
    require('../discoverRecommender').invalidateAllCaches();
  }
  return n;
}

module.exports = { ...client, ...library, ...userData, syncLibraryAndUsers };
