// This is a basic uniswap frontrunning MEV bot
// Made by Merunas follow me on youtube to see how to use it and edit it: https://www.youtube.com/channel/UCJInIwgW1duAEnMHHxDK7XQ

// 1. Setup ethers, required variables, contracts and start function
require('dotenv').config();
const { Wallet, ethers } = require('ethers');
const { FlashbotsBundleProvider, FlashbotsBundleResolution } = require('@flashbots/ethers-provider-bundle');
const { getPairAddress } = require('./utils');


// 1.1 Setup config
const config = require('./config.json')[process.argv[2] || 'goerli'];
const bribeToMiners = ethers.utils.parseUnits('20', 'gwei');
const buyAmount = ethers.utils.parseUnits('0.1', 'ether');
const GAS_LIMIT = 300_000;

// 1.2 Setup contracts and providers
const provider = new ethers.providers.JsonRpcProvider(config.httpProviderURL);
const wsProvider = new ethers.providers.WebSocketProvider(config.wsProviderURL);
const signingWallet = new Wallet(process.env.PRIVATE_KEY).connect(provider);

const { abi: uniswapRouterAbi, bytecode: uniswapRouterBytecode } = require('@uniswap/v2-periphery/build/UniswapV2Router02.json'); 
const { abi: pairAbi, bytecode: pairBytecode } = require('@uniswap/v2-core/build/UniswapV2Pair.json');
const { abi: erc20Abi, bytecode: erc20Bytecode } = require('@uniswap/v2-core/build/ERC20.json');
const { abi: universalRouterAbi } = require('@uniswap/universal-router/artifacts/contracts/UniversalRouter.sol/UniversalRouter.json');

const uniswapRouter = new ethers.ContractFactory(uniswapRouterAbi, uniswapRouterBytecode, signingWallet).attach(config.uniswapRouter);
const pairFactory = new ethers.ContractFactory(pairAbi, pairBytecode, signingWallet);
const erc20Factory = new ethers.ContractFactory(erc20Abi, erc20Bytecode, signingWallet);
const universalRouterInterface = new ethers.utils.Interface(universalRouterAbi);

// Runtime variables
let flashbotsProvider;
let wethAddress;
let factoryAddress;


// 2. Decode uniswap universal router transactions
const decodeUniversalRouterSwap = input => {
    const abiCoder = new ethers.utils.AbiCoder();
    const decodedParameters = abiCoder.decode(['address', 'uint256', 'uint256', 'bytes', 'bool'], input);
    const breakdown = input.substring(2).match(/.{1,64}/g); // TODO maybe faster way without regex?

    let path = [];
    if (breakdown.length != 9) {
        const pathOne = '0x' + breakdown[breakdown.length - 2].substring(24);
        const pathTwo = '0x' + breakdown[breakdown.length - 1].substring(24);
        path = [pathOne, pathTwo];
    }

    return {
        recipient: parseInt(decodedParameters[0, 16]),
        amountIn: decodedParameters[1],
        minAmountOut: decodedParameters[2], // basically slippage
        path,
    };
}

// 3. Setup initial checks
const initialChecks = async tx => {
    let transaction = null;
    let decoded = null;

    try {
        transaction = await provider.getTransaction(tx);
    } catch (e) {
        return false;
    }

    if (!transaction || !transaction.to || Number(transaction.value) == 0) return false;
    if (transaction.to.toLowerCase() !== config.universalRouter.toLowerCase()) return false;

    try {
        decoded = universalRouterInterface.parseTransaction(transaction);
    } catch (e) {
        return false;
    }

    // If the swap is not for uniswapV2 we return it  // TODO support v3? 0x00 0x01 0x09 
    if (!decoded.args.commands.includes('08')) return false;

    let swapPositionInCommands = decoded.args.commands.substring(2).indexOf('08') / 2;
    const decodedSwap = decodeUniversalRouterSwap(decoded.args.inputs[swapPositionInCommands]);

    // Recipient 2 is a flag for ADDRESS_THIS (the router itself) 1 is MSG_SENDER (the caller)
    // https://github.com/Uniswap/universal-router/blob/85669462f337bbe751313fc4ccb316f9bb7967c0/contracts/libraries/Recipient.sol
    if (decodedSwap.recipient === 2) return false;

    // Only support (w)ETH -> TOKEN swaps for now
    if (decodedSwap.path.length != 2) return false;
    if (decodedSwap.path[0].toLowerCase() !== wethAddress.toLowerCase()) return false;

    return {
        transaction,
        amountIn: transaction.value,
        minAmountOut: decodedSwap.minAmountOut,
        tokenToCapture: decodedSwap.path[1],
    };
}

// 4. Process transaction
const processTransaction = async tx => {
    const checksPassed = await initialChecks(tx);
    if (!checksPassed) return false;
    const { 
        transaction,
        amountIn, // Victim's ETH
        minAmountOut,
        tokenToCapture,
    } = checksPassed;

    console.log('checks passed', tx);

    // 5. Get and sort the reserves
    const pairAddress = getPairAddress(factoryAddress, wethAddress, tokenToCapture);
    const pair = pairFactory.attach(pairAddress);

    let reserves = null;
    try {
        reserves = await pair.getReserves();
    } catch (e) {
        return false;
    }

    let a;
    let b;
    if (wethAddress < tokenToCapture) { // TODO: fixme?
        a = reserves._reserve0;
        b = reserves._reserve1;
    } else {
        a = reserves._reserve1;
        b = reserves._reserve0;
    }

    // 6. Get fee costs for simplicity we'll add the user's gas fee
    const maxGasFee = transaction.maxFeePerGas ? transaction.maxFeePerGas.add(bribeToMiners) : bribeToMiners;
    const priorityFee = transaction.maxPriorityFeePerGas ? transaction.maxPriorityFeePerGas.add(bribeToMiners) : bribeToMiners;

    // 7. Buy using your amount in and calculate amount out
    const firstAmountOut = await uniswapRouter.getAmountOut(buyAmount, a, b);
    const updatedReserveA = a.add(buyAmount);
    const updatedReserveB = b.add(firstAmountOut.mul(997).div(1000)); // TODO: shouldnt this be sub?

    // The price the victim buys at changed because we just "bought"
    const victimBuyAmount = await uniswapRouter.getAmountOut(amountIn, updatedReserveA, updatedReserveB);

    console.log('secondBuyAmount', victimBuyAmount.toString()); // TODO temp
    console.log('minAmountOut', minAmountOut.toString());
    if (victimBuyAmount.lt(minAmountOut)) return console.log('Victim would get less than the minimum');

    const updatedReserveA2 = updatedReserveA.add(amountIn);
    const updatedReserveB2 = updatedReserveB.add(victimBuyAmount.mul(997).div(1000)); // TODO: shouldnt this be sub?
    // How much ETH we get at the end with a potential profit
    const thirdAmountOut = await uniswapRouter.getAmountOut(firstAmountOut, updatedReserveB2, updatedReserveA2); // b -> a because we're swapping back

    // 8. Prepare first transaction
    const deadline = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour from now
    let firstTransaction = {
        signer: signingWallet,
        transaction: await uniswapRouter.populateTransaction.swapExactETHForTokens(
            firstAmountOut,
            [wethAddress, tokenToCapture],
            signingWallet.address,
            deadline,
            {
                value: buyAmount,
                type: 2,
                maxFeePerGas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: GAS_LIMIT,
            }
        )
    };
    firstTransaction.transaction = { // TODO check if this is needed still
        ...firstTransaction.transaction,
        chainId: config.chainId,
    };

    // 9. Prepare second transaction
    const victimsTransactionWithChainId = {
        chainId: config.chainId,
        ...transaction,
    };
    const signedMiddleTransaction = {
        signedTransaction: ethers.utils.serializeTransaction(victimsTransactionWithChainId, {
            r: victimsTransactionWithChainId.r,
            s: victimsTransactionWithChainId.s,
            v: victimsTransactionWithChainId.v,
        })
    };

    // 10. Prepare third transaction for the approval
    const erc20 = erc20Factory.attach(tokenToCapture); // TODO a faster way than approve?
    let thirdTransaction = {
        signer: signingWallet,
        transaction: await erc20.populateTransaction.approve(
            config.uniswapRouter,
            firstAmountOut,
            {
                value: '0',
                type: 2,
                maxFeePerGas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: GAS_LIMIT,
            }
        ),
    };
    thirdTransaction.transaction = {
        ...thirdTransaction.transaction,
        chainId: config.chainId,
    };

    // 11. Prepare the last transaction to get the final weth
    let fourthTransaction = {
        signer: signingWallet,
        transaction: await uniswapRouter.populateTransaction.swapExactTokensForETH(
            firstAmountOut,
            thirdAmountOut,
            [tokenToCapture, wethAddress],
            signingWallet.address,
            deadline,
            {
                value: '0',
                type: 2,
                maxFeePerGas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: GAS_LIMIT,
            }
        )
    };
    fourthTransaction.transaction = {
        ...fourthTransaction.transaction,
        chainId: config.chainId,
    };

    const signedTransactions = await flashbotsProvider.signBundle([ // TODO perf check this
        firstTransaction,
        signedMiddleTransaction,
        thirdTransaction,
        fourthTransaction,
    ]);
    const blockNumber = await provider.getBlockNumber() + 1; // TODO maybe subscribe and create global variable
    console.log('Simulating...');

    const simulation = await flashbotsProvider.simulate(signedTransactions, blockNumber);
    if (simulation.firstRevert || simulation.error) {
        return console.log('Simulation error', simulation.firstRevert || simulation.error);
    } else {
        console.log('Simulation success', simulation);
    }

    // 12. Send transactions with flashbots
    let bundleSubmission;
    flashbotsProvider.sendRawBundle(signedTransactions, blockNumber).then(_bundleSubmission => {
        bundleSubmission = _bundleSubmission;
        console.log('Bundle submitted', bundleSubmission.bundleHash);
        return bundleSubmission.wait();
    }).then(async waitResponse => {
        console.log('Wait response', FlashbotsBundleResolution[waitResponse]);
        if (waitResponse == FlashbotsBundleResolution.BundleIncluded) {
            console.log('-------------------------------------------');
            console.log('-------------------------------------------');
            console.log('----------- Bundle Included ---------------');
            console.log('-------------------------------------------');
            console.log('-------------------------------------------');
        } else if (waitResponse == FlashbotsBundleResolution.AccountNonceTooHigh) {
            console.log('The transaction has been confirmed already');
        } else {
            console.log('Bundle hash', bundleSubmission.bundleHash);
            try {
                console.log({
                    bundleStats: await flashbotsProvider.getBundleStats(bundleSubmission.bundleHash, blockNumber),
                    userStats: await flashbotsProvider.getUserStats(),
                });
            } catch (e) {
                return false;
            }
        }
    });
}

const start = async () => {
    flashbotsProvider = await FlashbotsBundleProvider.create(provider, signingWallet, config.flashbotsURL);
    wethAddress = await uniswapRouter.WETH();
    factoryAddress = await uniswapRouter.factory();

    console.log('Listening for transactions on the chain id', config.chainId);
    wsProvider.on('pending', tx => {
        // console.log('tx', tx);
        processTransaction(tx);
    });
}

start();


// TODO Next steps:
// - Calculate gas costs
// - Estimate the next base fee
// - Calculate amounts out locally
// - Use multiple block builders besides flashbots
// - Reduce gas costs by using an assembly yul contract
// - Use multiple cores from your computer to improve performance
// - Calculate the transaction array for type 0 and type 2 transactions
// - Implement multiple dexes like uniswap, shibaswap, sushiswap and others
// - Calculate the exact amount you'll get in profit after the first, middle and last trade without a request and without loops
