process.env.NTBA_FIX_319 = 1; // needed for telegram issue

const config = require('./config');
const BFX = require('bitfinex-api-node');

const mongoose = require('mongoose');
const Price = require('./models/price');
const { RSI } = require('technicalindicators');
const TelegramBot = require('node-telegram-bot-api');

const CANDLE_KEY = 'trade:1m:tEOSUSD';
const telegramOnline = true;
let currentPrice = '';
let currentRSI = '';
let takeProfitOrderPrice = '';
let stopLossOrderPrice = '';
let positionOpen = false;
let balance = {};
let blockOpeningNewPosition = false;

mongoose.connect('mongodb+srv://unhodl:4y8xktwaoTxNQxUy@unhodl-db-eadeo.mongodb.net/test?retryWrites=true');

const bot = new TelegramBot(config.telegram.token, {
  polling: true,
});

bot.onText(/\/balance/, function onBalanceMsg(msg) {
  bot.sendMessage(config.telegram.chat, `Available balance: ${balance.available}\nAvailable amount: ${balance.amount}`);
});

bot.onText(/\/close/, function onCloseMsg(msg) {
  bot.sendMessage(config.telegram.chat, 'close received - implementation pending');
});

const bfx = new BFX({
  apiKey: config.bitfinex.key,
  apiSecret: config.bitfinex.secret,
  ws: {
    autoReconnect: true,
    seqAudit: true,
    packetWDDelay: 10 * 1000,
  },
});

const ws = bfx.ws(2, {
  manageCandles: true, // enable candle dataset persistence/management
  transform: true, // converts ws data arrays to Candle models (and others)
});

const rest = bfx.rest(2, {
  transform: true,
});

if (telegramOnline) bot.sendMessage(config.telegram.chat, `${new Date().toLocaleTimeString()} - unHODL Bot started...`);

function checkClosing() {
  let success = false;
  let closed = false;
  if (positionOpen === 'long' && currentPrice >= takeProfitOrderPrice) {
    positionOpen = false;
    success = true;
    closed = true;
  } else if (positionOpen === 'long' && currentPrice <= stopLossOrderPrice) {
    positionOpen = false;
    success = false;
    closed = true;
  } else if (positionOpen === 'short' && currentPrice <= takeProfitOrderPrice) {
    positionOpen = false;
    success = true;
    closed = true;
  } else if (positionOpen === 'short' && currentPrice >= stopLossOrderPrice) {
    positionOpen = false;
    success = false;
    closed = true;
  }
  if (closed) {
    const msg = `${new Date().toLocaleTimeString()} - Postition closed @: ${takeProfitOrderPrice} ${(success) ? '(SUCCESS)': '(FAILED)'}`;
    console.log(msg);
    if (telegramOnline) {
      bot.sendMessage(config.telegram.chat, msg);
    }
  }
}

function handleOpenPosition() {
  blockOpeningNewPosition = true;
  const msg = `${new Date().toLocaleTimeString()} - RSI: ${currentRSI} @ ${currentPrice} (TP: ${takeProfitOrderPrice})(SL: ${stopLossOrderPrice})`;
  console.log(msg);
  console.log('Postition opened');
  if (telegramOnline) {
    bot.sendMessage(config.telegram.chat, msg);
  }
};

function rsiCalculation(closeData) {
  const inputRSI = {
    values: closeData,
    period: 14,
  };
  const rsiResultArray = RSI.calculate(inputRSI);
  currentRSI = rsiResultArray[rsiResultArray.length - 1];

  if (blockOpeningNewPosition && 
    (currentRSI < config.indicators.rsi.longValue ||
    currentRSI > config.indicators.rsi.shortValue)) {
      blockOpeningNewPosition = false;
    };
  // open long position
  if (currentRSI >= config.indicators.rsi.longValue && !positionOpen && !blockOpeningNewPosition) {
    takeProfitOrderPrice = (currentPrice * (1 + (config.trading.takeProfitPerc / 100))).toFixed(3);
    stopLossOrderPrice = (currentPrice * (1 - (config.trading.stopLossPerc / 100))).toFixed(3);
    positionOpen = 'long';
    handleOpenPosition();
    }
    // open short position
  else if (currentRSI <= config.indicators.rsi.shortValue && !positionOpen && !blockOpeningNewPosition) {
    takeProfitOrderPrice = (currentPrice * (1 - (config.trading.takeProfitPerc / 100))).toFixed(3);
    stopLossOrderPrice = (currentPrice * (1 + (config.trading.stopLossPerc / 100))).toFixed(3);
    positionOpen = 'short';
    handleOpenPosition();
  }
  console.log(`${new Date().toLocaleTimeString()} - RSI : ${currentRSI} @ ${currentPrice}`);
}

const savePriceToDb = async () => {
  const price = new Price({
    _id: new mongoose.Types.ObjectId(),
    pair: 'EOSUSD',
    time: new Date().toLocaleTimeString(),
    price: currentPrice,
  });

  await price.save((err) => {
    if (err) {
      return console.log(err);
    }
    return true;
  });
};

const checkPostitions = async () => {
  const positions = await rest.positions();

  if (positions.length === 0) {
    return console.log('no open positions');
  }
  console.log(`${new Date().toLocaleTimeString()} - Pos Amount: ${positions[0].amount}`);
  console.log(`${new Date().toLocaleTimeString()} - Pos P/L: ${(positions[0].pl).toFixed(2)} (${(positions[0].plPerc).toFixed(2)}%)`);
  return true;
};

const checkBalances = async () => {
  const balances = await rest.balances();
  balances.forEach(b => {
    if (b.type === 'trading' && b.currency === 'usd') {
      console.log(`${new Date().toLocaleTimeString()} - Wallet amount: ${b.amount}`);
      console.log(`${new Date().toLocaleTimeString()} - Wallet available: ${b.available}`);
      balance.available = b.available;
      balance.amount = b.amount;
    }
  });
};

bot.on('polling_error', (error) => {
  console.log(`Telegram Error - ${error.message}`);
  //  telegramOnline = false;
  //  bot.stopPolling();
});

ws.on('error', (err) => { console.log(err); });
ws.on('close', () => console.log('closed'));

ws.on('open', () => {
  ws.auth.bind(ws);
  console.log('Bitfinex Websocket open...');
  ws.subscribeCandles(CANDLE_KEY);
});

ws.onCandle({ key: CANDLE_KEY }, (candles) => {
  currentPrice = candles[0].close; // current candle close is most accurate price vs. ticker
  checkClosing();
  rsiCalculation(candles.map(x => x.close).reverse());
  savePriceToDb();
});

setInterval(() => {
  checkBalances();
  checkPostitions();
}, 10000);

ws.open();

// Testing Area ---------------------------

/*
const bfxREST = bfx.rest(2, {
  transform: true,
});

function checkPrice() {
  if (config.bitfinex.key !== '') {
    const rest = bfx.rest(2, {
      transform: true,
    });
    rest.ticker('tEOSUSD', (err, res) => {
      if (err) console.log(err);
      console.log(`Bid:  ${res.bid}`);
      console.log(`Ask:  ${res.ask}`);
    });
  }
}

// Execute Order

const { Order } = require('./node_modules/bitfinex-api-node/lib/models');

 bfxWS.once('auth', () => {
  const o = new Order({
    cid: Date.now(),
    symbol: 'tETHUSD',
    amount: -0.1,
    price: 600,
    type: Order.type.LIMIT,
  }, bfxWS);

  // Enable automatic updates
  o.registerListeners();

  o.on('update', () => {
    console.log(`order updated: ${o.serialize()}`);
  });

  o.on('close', () => {
    console.log(`order closed: ${o.status}`);
    bfxWS.close();
  });

  o.submit().then(() => {
    console.log(`submitted order ${o.id}`);
  }).catch((err) => {
    console.error(err);
    bfxWS.close();
  });
});

 ws.open();
 */
