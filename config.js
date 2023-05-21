const { ethers } = require('ethers');


const config = {
  maxBuyAmount: ethers.utils.parseUnits('1.0', 'ether'),
  gasLimit: 300_000,

  networks: {
    goerli: {
      chainId: 5,
      flashbotsURL: 'https://relay-goerli.flashbots.net',
      httpProviderURL: `https://goerli.infura.io/v3/${process.env.INFURA_API_KEY}`,
      wsProviderURL: `wss://goerli.infura.io/ws/v3/${process.env.INFURA_API_KEY}`,
      uniswapRouter: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      universalRouter: '0x4648a43B2C14Da09FdF82B161150d3F634f40491',
    },
    mainnet: {
      chainId: 1,
      flashbotsURL: 'https://relay.flashbots.net',
      httpProviderURL: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
      wsProviderURL: `wss://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
      uniswapRouter: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      universalRouter: '0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B',
    },
  }
};

module.exports = config;
