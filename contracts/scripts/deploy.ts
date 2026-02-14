import { ethers } from "hardhat";

async function main() {
  const tokenAddress = process.env.USDC_ADDRESS;
  const feeRecipient = process.env.FEE_RECIPIENT;
  if (!tokenAddress || !feeRecipient) {
    throw new Error("Set USDC_ADDRESS and FEE_RECIPIENT before deploy");
  }

  const factory = await ethers.getContractFactory("PayInboxVault");
  const vault = await factory.deploy(tokenAddress, 250, feeRecipient);
  await vault.waitForDeployment();

  const registry = await ethers.getContractFactory("PricingRegistry");
  const pricing = await registry.deploy();
  await pricing.waitForDeployment();

  console.log("PayInboxVault", await vault.getAddress());
  console.log("PricingRegistry", await pricing.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
