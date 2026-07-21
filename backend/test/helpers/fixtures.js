const { cloneFixture } = require('../fixtures/market');

function fresh(factory, ...args) {
  return cloneFixture(factory(...args));
}

module.exports = { fresh };
