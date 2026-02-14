module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.spec.ts'],
  verbose: false,
  // Ensure long-lived clients (pg/redis/ethers providers) do not keep the Jest
  // process alive when running in production-style stack mode.
  setupFilesAfterEnv: ['<rootDir>/tests/jest.afterEnv.ts'],
  globalTeardown: '<rootDir>/tests/teardown.ts',
};
