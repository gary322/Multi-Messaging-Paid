import { ethers } from 'hardhat';

const requiredError = (name: string) => {
  throw new Error(`Missing ${name}. Set ${name} as env var.`);
};

async function main() {
  const tokenAddress = process.env.USDC_ADDRESS ?? requiredError('USDC_ADDRESS');
  const recipient = process.env.RECIPIENT ?? requiredError('RECIPIENT');
  const amount = process.env.AMOUNT ?? '1000000000';

  const token = (await ethers.getContractAt('MockERC20', tokenAddress)) as any;
  const decimals = Number(await token.decimals());
  const scale = 10n ** BigInt(decimals);
  const [funder] = await ethers.getSigners();
  const qty = BigInt(amount) * scale;

  const tx = await token.connect(funder).mint(recipient, qty);
  const receipt = await tx.wait();

  console.log(JSON.stringify({ recipient, amount: amount.toString(), decimals, minted: qty.toString(), txHash: receipt?.hash ?? '' }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
