import { ethers } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  const tokenName = process.env.TOKEN_NAME ?? 'Mock USDC';
  const tokenSymbol = process.env.TOKEN_SYMBOL ?? 'USDC';
  const tokenDecimals = Number(process.env.TOKEN_DECIMALS ?? '6');
  const feeBps = Number(process.env.FEE_BPS ?? '250');
  const feeRecipient = process.env.FEE_RECIPIENT ?? deployer.address;

  const MockERC20 = await ethers.getContractFactory('MockERC20');
  const token = await MockERC20.deploy(tokenName, tokenSymbol, tokenDecimals);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  const Vault = await ethers.getContractFactory('PayInboxVault');
  const vault = await Vault.deploy(tokenAddress, feeBps, feeRecipient);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  const PricingRegistry = await ethers.getContractFactory('PricingRegistry');
  const pricingRegistry = await PricingRegistry.deploy();
  await pricingRegistry.waitForDeployment();
  const pricingRegistryAddress = await pricingRegistry.getAddress();

  const depositAmount = process.env.DEPOSIT_AMOUNT;
  if (depositAmount) {
    const amount = BigInt(depositAmount);
    const tenPowDecimals = 10n ** BigInt(tokenDecimals);
    const mintedAmount = amount * tenPowDecimals;
    await token.mint(deployer.address, mintedAmount);
    await token.approve(vaultAddress, mintedAmount);
    await vault.deposit(mintedAmount);
  }

  const network = await ethers.provider.getNetwork();
  console.log(
    JSON.stringify(
      {
        chainId: Number(network.chainId),
        tokenAddress,
        vaultAddress,
        pricingRegistryAddress,
        deployer: deployer.address,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
