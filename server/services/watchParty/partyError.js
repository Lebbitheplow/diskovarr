// An error whose message is written for the person using the party page.
class PartyError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

module.exports = PartyError;
