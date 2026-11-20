#!/usr/bin/env bash
# Guided setup for Study Flow's Discord and email connections.
# Secrets are typed with hidden input and written only to server/.env (mode 600).
# Nothing is printed back, posted or sent. Usage: ./setup-integrations.sh [path/to/.env]
set -euo pipefail
umask 077

ENV_FILE="${1:-$(cd "$(dirname "$0")" && pwd)/server/.env}"
touch "$ENV_FILE" && chmod 600 "$ENV_FILE"

b=$'\e[1m'; d=$'\e[2m'; g=$'\e[32m'; y=$'\e[33m'; c=$'\e[36m'; r=$'\e[0m'
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s%s%s\n' "$b$c" "$*" "$r"; }
ask()  { local __v; read -r -p "$1 " __v; printf '%s' "$__v"; }
secret() { local __v; read -r -s -p "$1 " __v; echo >&2; printf '%s' "$__v"; }
yes()  { local a; read -r -p "$1 [Y/n] " a; [[ -z "$a" || "$a" =~ ^[Yy] ]]; }

# set_kv KEY VALUE: replace or append KEY=VALUE. The value travels via the environment, not argv.
set_kv() {
  local tmp; tmp="$(mktemp "${ENV_FILE}.XXXX")"
  K="$1" V="$2" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]; done=0}
    index($0, k"=")==1 {print k"="v; done=1; next} {print}
    END{if(!done) print k"="v}' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp" && mv "$tmp" "$ENV_FILE"
  SAVED+=("$1")
}
SAVED=()

say "${b}Study Flow: connect Discord and email${r}"
say "${d}Settings go to $ENV_FILE (only you can read it). Press Enter to skip any question.${r}"

# ------------------------------------------------------------------ email
setup_email() {
  step "Email (club mail and your college counselor)"
  say "Which account should Study Flow read, and send your approved drafts from?"
  say "  1) Gmail (personal or school Google account)"
  say "  2) iCloud Mail"
  say "  3) Yahoo Mail"
  say "  4) Other (I know the IMAP/SMTP server names)"
  local choice imap smtp help
  choice="$(ask "Pick 1-4:")"
  case "$choice" in
    1) imap="imap.gmail.com:993"; smtp="smtp.gmail.com:587"
       help="Google needs an ${b}app password${r}, not your normal password:
   1. Turn on 2-Step Verification: https://myaccount.google.com/signinoptions/twosv
   2. Create an app password named \"Study Flow\": https://myaccount.google.com/apppasswords
   ${d}School accounts: if that page says the setting isn't available, your district has
   blocked app passwords. Use a personal Gmail instead, and forward school mail to it.${r}" ;;
    2) imap="imap.mail.me.com:993"; smtp="smtp.mail.me.com:587"
       help="Apple needs an ${b}app-specific password${r}: https://account.apple.com → Sign-In and Security → App-Specific Passwords" ;;
    3) imap="imap.mail.yahoo.com:993"; smtp="smtp.mail.yahoo.com:465"
       help="Yahoo needs an ${b}app password${r}: Account Info → Account Security → Generate app password" ;;
    4) imap="$(ask "IMAP server (host:port, usually port 993):")"
       smtp="$(ask "SMTP server (host:port, 587 or 465):")"
       help="Use an app password if your provider offers one." ;;
    *) say "Skipping email."; return ;;
  esac
  say ""; say "$help"; say ""
  local addr pass name filters
  addr="$(ask "Email address:")"
  [[ "$addr" == *@*.* ]] || { say "${y}That doesn't look like an email address. Skipping email.${r}"; return; }
  pass="$(secret "App password (hidden while you type):")"
  pass="${pass// /}"   # Google shows app passwords in groups of four
  [[ -n "$pass" ]] || { say "${y}No password entered. Skipping email.${r}"; return; }

  set_kv IMAP_ADDR "$imap"
  set_kv IMAP_USER "$addr"
  set_kv IMAP_PASSWORD "$pass"

  say ""
  say "Only emails whose sender or subject contains one of these words reach your Inbox:"
  local def="esuhsd.org,counselor,college,club,robotics,scholarship"
  filters="$(ask "Keywords, comma separated [$def]:")"
  set_kv IMAP_FILTERS "${filters:-$def}"

  if yes "Also let Study Flow send the drafts you approve (always one email at a time, after you press Send)?"; then
    name="$(ask "Name shown on sent emails (optional):")"
    set_kv SMTP_ADDR "$smtp"
    set_kv SMTP_USER "$addr"
    set_kv SMTP_PASSWORD "$pass"
    if [[ -n "$name" ]]; then set_kv SMTP_FROM "$name <$addr>"; else set_kv SMTP_FROM "$addr"; fi
  fi
  unset pass
  say "${g}✓ Email saved.${r}"
}

# ------------------------------------------------------------------ discord
setup_discord() {
  step "Discord (club announcements)"
  say "Two separate pieces. Do one, both or neither:"
  say "  • ${b}Read${r} club channels into your Inbox, using a bot. It only works in servers where you"
  say "    (or an admin you ask) can add bots."
  say "  • ${b}Post${r} your plan to a channel, using a webhook. You need Manage Webhooks in that channel."

  if yes "Set up reading with a bot?"; then
    say ""
    say "  1. Open https://discord.com/developers/applications → ${b}New Application${r}, name it \"Study Flow\"."
    say "  2. Left menu ${b}Bot${r}: turn ON ${b}Message Content Intent${r} and save. Then press ${b}Reset Token${r} and copy it."
    local app token chans
    app="$(ask "  3. Paste the Application ID (General Information page; it isn't secret):")"
    if [[ "$app" =~ ^[0-9]{15,22}$ ]]; then
      say "     Open this link and pick the club server (it asks only for View Channels + Read Message History):"
      say "     ${c}https://discord.com/oauth2/authorize?client_id=${app}&scope=bot&permissions=66560${r}"
    fi
    say "  4. In Discord: Settings → Advanced → turn on ${b}Developer Mode${r}. Then right-click each club channel → ${b}Copy Channel ID${r}."
    token="$(secret "  Bot token (hidden):")"
    chans="$(ask "  Channel IDs, comma separated:")"
    chans="${chans// /}"
    if [[ -n "$token" && "$chans" =~ ^[0-9,]+$ ]]; then
      set_kv DISCORD_BOT_TOKEN "$token"
      set_kv DISCORD_CHANNEL_IDS "$chans"
      say "${g}✓ Discord reading saved.${r}"
    else
      say "${y}Need both a token and numeric channel IDs. Skipping reading.${r}"
    fi
    unset token
  fi

  if yes "Set up posting with a webhook?"; then
    say "  Channel ⚙ Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL."
    local hook
    hook="$(secret "  Webhook URL (hidden):")"
    if [[ "$hook" =~ ^https://(ptb\.|canary\.)?discord(app)?\.com/api/webhooks/ ]]; then
      set_kv DISCORD_WEBHOOK_URL "$hook"
      say "${g}✓ Webhook saved. Posts only happen when you press Share.${r}"
    elif [[ -n "$hook" ]]; then
      say "${y}That isn't a Discord webhook URL. Skipping posting.${r}"
    fi
    unset hook
  fi
}

step "What do you want to connect?"
say "  1) Email   2) Discord   3) Both"
case "$(ask "Pick 1-3:")" in
  1) setup_email ;;
  2) setup_discord ;;
  3) setup_email; setup_discord ;;
  *) say "Nothing changed." ;;
esac

step "Done"
if ((${#SAVED[@]})); then
  say "Saved: ${SAVED[*]}"
  say "${d}(values are hidden; they live only in $ENV_FILE)${r}"
  say "Restart the relay to use them. If Claude set this up for you, just tell Claude you're done."
else
  say "Nothing was saved."
fi
say "SETUP-FINISHED"
