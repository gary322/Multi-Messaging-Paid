import { ethers } from 'ethers';

type ManagedSignerMapKey = string;

const managedSigners = new Map<ManagedSignerMapKey, ethers.NonceManager>();
const managedReadOnlyProviders = new Map<string, ethers.JsonRpcProvider>();

const VAULT_ABI = [
  'function deposit(uint256 amount)',
  'function withdraw(uint256 amount)',
  'function sendMessagePayment(address recipient, bytes32 messageId, bytes32 contentHash, uint32 channel, uint256 amount)',
  'function balanceOf(address user) view returns (uint256)',
  'function setFeeConfig(uint16 feeBps, address recipient)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
];

function normalizeChainAddress(input: string, label = 'address'): string {
  if (!input || typeof input !== 'string') {
    throw new Error(`Invalid ${label}`);
  }
  try {
    return ethers.getAddress(input);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

export function isValidChainAddress(input: string): boolean {
  return typeof input === 'string' && ethers.isAddress(input);
}

export function normalizeChainAmount(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount)) {
    throw new Error('Invalid chain amount');
  }
  const dec = Number.isInteger(decimals) ? decimals : 6;
  return BigInt(amount) * 10n ** BigInt(dec);
}

export function denormalizeChainAmount(amount: bigint, decimals: number): number {
  if (amount < 0n) {
    return 0;
  }
  const dec = Number.isInteger(decimals) ? decimals : 6;
  return Number(ethers.formatUnits(amount, dec));
}

export async function getLatestBlockNumber(rpcUrl: string): Promise<number> {
  const provider = await buildReadOnlyProvider(rpcUrl);
  if (!provider) return 0;
  return Number(await provider.getBlockNumber());
}

function normalizeRpcUrl(rpcUrl: string) {
  return rpcUrl.trim();
}

export async function buildReadOnlyProvider(rpcUrl?: string) {
  if (!rpcUrl) return null;
  const normalized = normalizeRpcUrl(rpcUrl);
  const existing = managedReadOnlyProviders.get(normalized);
  if (existing) {
    return existing;
  }
  const provider = new ethers.JsonRpcProvider(normalized);
  managedReadOnlyProviders.set(normalized, provider);
  return provider;
}

export async function getChainId(rpcUrl: string): Promise<number> {
  const p = await buildReadOnlyProvider(rpcUrl);
  if (!p) return 0;
  const { chainId } = await p.getNetwork();
  return Number(chainId);
}

export async function readChainBalance(
  rpcUrl: string,
  contractAddress: string,
  user: string,
  decimals = 6,
) {
  const provider = await buildReadOnlyProvider(rpcUrl);
  if (!provider) return null;
  const normalizedContractAddress = normalizeChainAddress(contractAddress, 'contractAddress');
  const normalizedUserAddress = normalizeChainAddress(user, 'userAddress');
  const abi = ['function balances(address) view returns (uint256)'];
  const contract = new ethers.Contract(normalizedContractAddress, abi, provider);
  const bal = await contract.balances(normalizedUserAddress);
  return denormalizeChainAmount(bal, decimals);
}

export function getWalletSigner(rpcUrl: string, privateKey: string) {
  if (!rpcUrl) throw new Error('RPC URL missing');
  const normalizedRpcUrl = normalizeRpcUrl(rpcUrl);
  const key = `${normalizedRpcUrl}::${privateKey}`;
  const existing = managedSigners.get(key);
  if (existing) return existing;

  const p = new ethers.JsonRpcProvider(normalizedRpcUrl);
  const signer = new ethers.Wallet(privateKey, p);
  const managed = new ethers.NonceManager(signer);
  managedSigners.set(key, managed);
  return managed;
}

export async function closeChainClients() {
  const signerClients = Array.from(managedSigners.values());
  managedSigners.clear();
  const signerProviders = signerClients
    .flatMap((signer) => {
      const directProvider = (signer as unknown as { provider?: unknown }).provider;
      const nestedProvider = (signer as unknown as { signer?: { provider?: unknown } }).signer?.provider;
      return [directProvider, nestedProvider].filter(Boolean) as unknown[];
    })
    .filter((provider, index, list) => list.indexOf(provider) === index);

  for (const provider of signerProviders) {
    const destroy = (provider as unknown as { destroy?: () => Promise<void> | void }).destroy;
    if (typeof destroy === 'function') {
      try {
        await Promise.resolve(destroy.call(provider));
      } catch {
        // Ignore provider close errors to prevent teardown hangs.
      }
    }
  }

  if (!managedReadOnlyProviders.size) return;
  const providers = Array.from(managedReadOnlyProviders.values());
  managedReadOnlyProviders.clear();
  await Promise.all(
    providers.map((provider) => {
      const destroy = (provider as unknown as { destroy?: () => Promise<void> | void }).destroy;
      if (typeof destroy === 'function') {
        return destroy.call(provider);
      }
      return Promise.resolve();
    }),
  );
}

export async function sendOnChainPayment(args: {
  rpcUrl: string;
  privateKey: string;
  contractAddress: string;
  recipient: string;
  messageId: string;
  contentHash: string;
  channel: number;
  amount: bigint;
}) {
  const vaultAddress = normalizeChainAddress(args.contractAddress, 'contractAddress');
  const recipient = normalizeChainAddress(args.recipient, 'recipient');
  const wallet = getWalletSigner(args.rpcUrl, args.privateKey);
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, wallet);
  const tx = await vault.sendMessagePayment(
    recipient,
    args.messageId,
    args.contentHash,
    args.channel,
    args.amount
  );
  const receipt = await tx.wait();
  return receipt?.hash ?? '';
}

export async function fetchMessagePaidEvents(params: {
  rpcUrl: string;
  vaultAddress: string;
  fromBlock: number;
  toBlock: number;
  chainIdHint?: number;
}) {
  const provider = await buildReadOnlyProvider(params.rpcUrl);
  if (!provider) return [];
  const vaultAddress = normalizeChainAddress(params.vaultAddress, 'vaultAddress');
  const abi = [
    'event MessagePaid(address indexed payer, address indexed recipient, bytes32 indexed messageId, uint256 amount, uint256 fee, bytes32 contentHash, uint64 nonce, uint32 channel)',
    'event Deposited(address indexed user, uint256 amount, uint256 newBalance)',
    'event Withdrawn(address indexed user, uint256 amount, uint256 newBalance)',
  ];
  const iface = new ethers.Interface(abi);
  const messagePaidEvent = iface.getEvent('MessagePaid');
  if (!messagePaidEvent) return [];
  const topic = messagePaidEvent.topicHash;
  const logs = await provider.getLogs({
    address: vaultAddress,
    fromBlock: params.fromBlock,
    toBlock: params.toBlock,
    topics: [topic],
  });

  const parsed = logs
    .map((log) => {
      try {
        const parsed = iface.parseLog(log);
        if (!parsed) {
          return null;
        }
        const args = parsed.args;
        return {
          txHash: log.transactionHash?.toLowerCase() ?? '',
          blockNumber: Number(log.blockNumber),
          blockHash: log.blockHash?.toLowerCase() ?? null,
          logIndex: Number(log.index),
          chainId: params.chainIdHint ?? 0,
          payer: (args[0] as string).toLowerCase(),
          recipient: (args[1] as string).toLowerCase(),
          messageId: (args[2] as string).toLowerCase(),
          amount: Number(ethers.getBigInt(args[3])),
          fee: Number(ethers.getBigInt(args[4])),
          contentHash: (args[5] as string).toLowerCase(),
          nonce: Number(args[6]),
          channel: Number(args[7]),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{
    txHash: string;
    blockNumber: number;
    blockHash: string | null;
    logIndex: number;
    chainId: number;
    payer: string;
    recipient: string;
    messageId: string;
    amount: number;
    fee: number;
    contentHash: string;
    nonce: number;
    channel: number;
  }>;

  return parsed;
}

export async function topupOnChainVault(args: {
  rpcUrl: string;
  privateKey: string;
  tokenAddress: string;
  vaultAddress: string;
  amount: bigint;
}) {
  const tokenAddress = normalizeChainAddress(args.tokenAddress, 'tokenAddress');
  const vaultAddress = normalizeChainAddress(args.vaultAddress, 'vaultAddress');
  const wallet = getWalletSigner(args.rpcUrl, args.privateKey);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, wallet);

  const approveTx = await token.approve(vaultAddress, args.amount);
  await approveTx.wait();
  const depositTx = await vault.deposit(args.amount);
  const receipt = await depositTx.wait();
  return receipt?.hash ?? '';
}

export async function withdrawFromVault(args: {
  rpcUrl: string;
  privateKey: string;
  vaultAddress: string;
  amount: bigint;
}) {
  const vaultAddress = normalizeChainAddress(args.vaultAddress, 'vaultAddress');
  const wallet = getWalletSigner(args.rpcUrl, args.privateKey);
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, wallet);
  const tx = await vault.withdraw(args.amount);
  const receipt = await tx.wait();
  return receipt?.hash ?? '';
}

export async function isChainConfigured(rpcUrl?: string, vaultAddress?: string) {
  return Boolean(rpcUrl && vaultAddress);
}
