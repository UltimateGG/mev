const fs = require('fs');
const path = require('path');
const { bytecode } = require('@uniswap/v2-core/build/UniswapV2Pair.json');
const { keccak256, pack } = require('@ethersproject/solidity');
const { getCreate2Address } = require('@ethersproject/address');
const { ethers, BigNumber } = require('ethers');

const network = process.argv[2] || 'goerli';
const INIT_CODE_HASH = keccak256(['bytes'], [`0x${bytecode}`]);
const CACHE_FILE_PATH = path.join(__dirname, `data/pairs_${network}.cache`);

// Load cache from disk if it exists
let pairCache = new Map();
if (fs.existsSync(CACHE_FILE_PATH)) {
  const cacheData = fs.readFileSync(CACHE_FILE_PATH, 'utf8');
  pairCache = new Map(JSON.parse(cacheData));
}

const sortAddresses = (tokenA, tokenB) => BigNumber.from(tokenA).lt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];

const getPairAddress = (factoryAddress, token1, token2) => {
  const key1 = token1 + token2;
  if (pairCache.has(key1)) return pairCache.get(key1);

  const addr = getCreate2Address( // Calculates locally
    factoryAddress,
    keccak256(['bytes'], [pack(['address', 'address'], sortAddresses(token1, token2))]),
    INIT_CODE_HASH
  );

  pairCache.set(key1, addr);
  pairCache.set(token2 + token1, addr); // Cache reverse pair as well

  fs.writeFile(CACHE_FILE_PATH, JSON.stringify(Array.from(pairCache)), 'utf8', () => {});
  return addr;
}

const FEE = BigNumber.from(997);
const ONE_THOUSAND = BigNumber.from(1000);

const getAmountOut = (amountIn, reserveIn, reserveOut) => {
  const amountInWithFee = amountIn.mul(FEE);
  const numerator = amountInWithFee.mul(reserveOut);
  const denominator = reserveIn.mul(ONE_THOUSAND).add(amountInWithFee);
  return numerator.div(denominator);
}

// Binary search to find the optimal buy amount without moving the price too much
const findOptimalBuyAmount = (amountIn, reserveA, reserveB, minAmountOut, maxBuyAmount) => {
  let left = ethers.constants.Zero;
  let right = maxBuyAmount;

  while (left.lt(right)) {
    const mid = left.add(right).div(ethers.constants.Two); // Calculate the middle point

    const ourAmountTokens = getAmountOut(mid, reserveA, reserveB);
    const updatedReserveA = reserveA.add(mid);
    const updatedReserveB = reserveB.sub(ourAmountTokens);
    const victimAmountTokens = getAmountOut(amountIn, updatedReserveA, updatedReserveB);

    if (victimAmountTokens.lt(minAmountOut)) {
      right = mid.sub(ethers.constants.One); // Adjust the right boundary
    } else {
      left = mid.add(ethers.constants.One); // Adjust the left boundary
    }
  }

  return right.sub(right.div(300)); // Sub 0.3% for slippage
}


module.exports = {
  sortAddresses,
  getPairAddress,
  getAmountOut,
  findOptimalBuyAmount,
};
