const { bytecode } = require('@uniswap/v2-core/build/UniswapV2Pair.json');
const { keccak256, pack } = require('@ethersproject/solidity');
const { getCreate2Address } = require('@ethersproject/address');
const { BigNumber } = require('ethers');


const INIT_CODE_HASH = keccak256(['bytes'], [`0x${bytecode}`]);
const pairCache = new Map();

const sortAddresses = (tokenA, tokenB) => BigNumber.from(tokenA).lt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];

// TODO: Cache to file per network
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
  return addr;
}


module.exports = {
  sortAddresses,
  getPairAddress
};
