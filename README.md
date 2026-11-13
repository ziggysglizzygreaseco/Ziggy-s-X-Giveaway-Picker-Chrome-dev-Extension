<!-- vibe coded by @ZiggysGlizzy on X -->
# Ziggy's Giveaway Picker

Made by @ZiggysGlizzy on X — https://x.com/ZiggysGlizzy

A Chrome extension that picks random winners for a giveaway post on X, using your own logged-in X session.

## Install
1. Unzip this file.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `x-giveaway-picker-extension` folder (not the zip or the outer folder).
4. Stay logged into X in the same Chrome profile.

## How to use
1. Paste the giveaway post link.
2. Set the rules: must-follow accounts (add as chips; winners must follow all of them), must like, must comment, and repost **or** quote. Every rule you switch on is required.
3. Choose 1–3 sweeps (default 2). More sweeps is more thorough: each re-reads the lists and merges new names, without duplicates.
4. Click **Collect from X**, then **Pick winners**.

## What you get
- **Fresh re-check:** each picked winner is checked again on live X pages before being marked verified.
- **Needs review:** if a follow can't be confirmed, the winner isn't removed. A clickable chip lets you check it yourself.
- **Redraw** any single winner under the original rules.
- **Verify followage:** a winner with a needs-review follow gets this button. It opens their X profile and looks for the "Follows you" tag, then updates the entry: green if confirmed, red "not following" if the tag is clearly missing after a full check (the winner is never removed for you — use Redraw if you want). Otherwise it stays needs review.
- **Sweep log** showing what each sweep added.
- **Coverage estimate:** collected names compared with the post's public counts. It's a rough count of actions, not a percentage of unique people.

## V1.5
Verify followage now finds the "Follows you" tag more reliably — it matches X's current label no matter how it's capitalized, also looks for the words "Follows you" beside the handle, waits up to about 30 seconds, and will not mark "not following" unless the tag is clearly missing after that check. A "Follow back" button is only backup; if the check still isn't sure, the entry stays needs review so you can try again.

## Limits
- X controls what it shows. Lists can load slowly, be hidden, or be incomplete, and page layouts change.
- Comment checks can count replies anywhere in the conversation, not only direct replies.
- The "Follows you" tag only shows for the X account you're logged into. For multiple accounts, it cannot auto-reverify followage. Those stay needs review ("Can't auto-check") for you to check with the profile link.
- Results are best effort, not a guarantee. Review winners before announcing them.

## Privacy
Usernames are read only to run your giveaway and are stored locally in Chrome. Nothing is uploaded, sold, or shared. The extension never posts, likes, reposts, follows, or messages anyone.
