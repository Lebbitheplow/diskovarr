const client = require('./client');
const library = require('./library');
const userData = require('./userData');

module.exports = { ...client, ...library, ...userData };
