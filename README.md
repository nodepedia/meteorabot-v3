# meteorabot-v3

This bot watches the tokens and pools you choose and opens liquidity positions for you on Meteora. Meteora is a Solana exchange where you place SOL (Solana's coin), and sometimes another token, into a price range and can earn a share of trading fees.

You pick a style and an amount of SOL. The bot waits for its signal, or for a price you set, then opens the position and looks after it. Depending on the style, it can take profit, follow a rise, reshape the position as the price moves, and close when the price leaves the range. A wide spot position can also close when it earns very little in fees. A wallet watcher can swap leftover tokens back into SOL.

It sends Telegram messages. On the regular status message you can tap a button to reshape a position or close it. An optional second Telegram bot can add a token to the watch list, so you do not have to edit that list by hand.

## The three styles

A position is your money placed across a price range. Meteora splits that range into small price steps, called bins. The style decides which side you fund, and what the bot waits for.

**Spot.** A wide position funded with SOL. The bot waits for an uptrend signal before it opens. That signal is Supertrend: a line drawn from recent prices. The bot only enters while the trend is up. If the price falls out of the bottom, the bot can close and open a token-only position aimed at selling if the price climbs back. If fees stay very low for a while, it can close. This fits a wide SOL position that follows the trend and steps aside when price or fees turn against it.

**Bid-ask, both sides.** The bot calls this bidask double. Both the token and SOL go in. The shape puts more of the money toward the edges of the range and less right at the current price. You can leave the timing to the uptrend signal, or set a target price first. After that price is touched, the bot still waits for the signal. If the price drops far enough, it can add more (an average-down) and reshape the position. This fits when you want both sides working, and the bot to add if the price falls.

**Bid-ask, SOL only.** You name a token and a price, or ask the bot to enter at the current price. Only SOL goes in, from the bottom of the range up to the current price. The bins above that stay empty. This style uses your price. It does not wait for the uptrend signal. This fits when you want to place SOL at a price you choose, without holding the token first.

On one pool the bot keeps at most one spot position and one bid-ask position. It will not open a second copy of the same style there. An average-down add does not count toward that limit.

## How it works

1. You name a token or a pool, pick a style, and choose how much SOL to use. You can write that in the watch list, or send it with the optional Telegram entry bot.
2. The bot watches the price. Spot and bid-ask both-sides wait for the uptrend signal. If you also set a target on a both-sides entry, the signal only counts after the price touches that target. SOL-only waits until the price reaches your target. If you chose "now", it opens as soon as it can read the price.
3. It opens the position and keeps watching. It may take profit, reshape, or close, and it messages you. Buttons on the status message reshape or close. The wallet watcher can turn leftover tokens back into SOL.

## Risk

This bot can spend real SOL and open real positions. A price move, a pool with very little money in it, fees, or a failed transaction can lose money. Liquidity can leave you holding more of a token than you started with. Use the practice mode in the setup guide before live trading. You use this at your own risk. It is not financial advice.

## Read next

- [Setup](setup.md) — install, keys, the watch list, and starting the bot
- [Optional workers](worker-setup.md) — the Telegram bot that adds tokens for you, and how the status buttons work
- [Project structure](PROJECT_STRUCTURE.md) — where the code and files live
