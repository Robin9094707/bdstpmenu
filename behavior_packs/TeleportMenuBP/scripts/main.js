import { system, world, Player } from "@minecraft/server";
import { ActionFormData, MessageFormData } from "@minecraft/server-ui";

const TRIGGER_ITEM_ID = "minecraft:stick";
const TITLE_PREFIX = "§b§lTeleport-Menü§r";
const REQUESTS = new Map();

function getDisplayName(player) {
  if (!player) {
    return "Unbekannt";
  }
  const nameTag = (player.nameTag ?? "").trim();
  return nameTag.length > 0 ? nameTag : player.name;
}

function getActiveRequests(targetId) {
  if (!REQUESTS.has(targetId)) {
    REQUESTS.set(targetId, []);
  }
  return REQUESTS.get(targetId);
}

function removeRequest(targetId, requesterId) {
  const entries = REQUESTS.get(targetId);
  if (!entries) return;
  const filtered = entries.filter((entry) => entry.requesterId !== requesterId);
  if (filtered.length === 0) {
    REQUESTS.delete(targetId);
  } else {
    REQUESTS.set(targetId, filtered);
  }
}

function removeRequestsByRequester(requesterId) {
  for (const [targetId, entries] of REQUESTS.entries()) {
    const filtered = entries.filter((entry) => entry.requesterId !== requesterId);
    if (filtered.length === 0) {
      REQUESTS.delete(targetId);
    } else if (filtered.length !== entries.length) {
      REQUESTS.set(targetId, filtered);
    }
  }
}

function findPlayerById(id) {
  for (const player of world.getPlayers()) {
    if (player.id === id) {
      return player;
    }
  }
  return undefined;
}

async function openMainMenu(player) {
  const form = new ActionFormData()
    .title(TITLE_PREFIX)
    .body("Wähle eine Funktion aus.")
    .button("§aTeleport-Anfrage senden")
    .button("§eAnfragen verwalten");

  const response = await form.show(player);
  if (response.canceled) return;

  switch (response.selection) {
    case 0:
      await openRequestMenu(player);
      break;
    case 1:
      await openPendingMenu(player);
      break;
  }
}

async function openRequestMenu(requester) {
  const targets = [...world.getPlayers()].filter((player) => player.id !== requester.id);
  if (targets.length === 0) {
    requester.sendMessage("§7[Teleport] Keine anderen Spieler online.");
    return;
  }

  const form = new ActionFormData()
    .title(TITLE_PREFIX)
    .body("Wähle den Spieler, zu dem du dich teleportieren möchtest.");

  for (const target of targets) {
    form.button(`${getDisplayName(target)}`);
  }

  const response = await form.show(requester);
  if (response.canceled || response.selection === undefined) {
    return;
  }

  const target = targets[response.selection];
  if (!target) {
    requester.sendMessage("§c[Teleport] Der Spieler ist nicht mehr verfügbar.");
    return;
  }

  registerRequest(requester, target);
}

async function openPendingMenu(target) {
  const entries = [...(REQUESTS.get(target.id) ?? [])];
  if (entries.length === 0) {
    target.sendMessage("§7[Teleport] Keine offenen Anfragen.");
    return;
  }

  const form = new ActionFormData()
    .title(TITLE_PREFIX)
    .body("Wähle eine Anfrage zum Bearbeiten aus.");

  for (const entry of entries) {
    form.button(`${entry.requesterName}`);
  }

  const response = await form.show(target);
  if (response.canceled || response.selection === undefined) {
    return;
  }

  const entry = entries[response.selection];
  if (!entry) {
    target.sendMessage("§c[Teleport] Die Anfrage existiert nicht mehr.");
    return;
  }

  await handleRequestDecision(target, entry);
}

async function handleRequestDecision(target, entry) {
  const requester = findPlayerById(entry.requesterId);
  const prompt = new MessageFormData()
    .title(TITLE_PREFIX)
    .body(
      requester
        ? `${entry.requesterName} möchte sich zu dir teleportieren.`
        : `${entry.requesterName} ist nicht mehr online.`
    )
    .button1("§cAblehnen")
    .button2("§aAnnehmen");

  const response = await prompt.show(target);
  const accepted = response.selection === 1;

  if (!requester) {
    target.sendMessage("§7[Teleport] Der anfragende Spieler ist nicht mehr online.");
    removeRequest(entry.targetId, entry.requesterId);
    return;
  }

  if (accepted) {
    requester.teleport(target.location, {
      dimension: target.dimension,
    });
    requester.sendMessage(`§a[Teleport] ${getDisplayName(target)} hat deine Anfrage akzeptiert.`);
    target.sendMessage(`§a[Teleport] ${entry.requesterName} wurde zu dir teleportiert.`);
  } else {
    requester.sendMessage(`§c[Teleport] ${getDisplayName(target)} hat deine Anfrage abgelehnt.`);
    target.sendMessage("§7[Teleport] Anfrage abgelehnt.");
  }

  removeRequest(entry.targetId, entry.requesterId);
}

function registerRequest(requester, target) {
  const targetEntries = getActiveRequests(target.id);
  const filtered = targetEntries.filter((entry) => entry.requesterId !== requester.id);
  filtered.push({
    requesterId: requester.id,
    requesterName: getDisplayName(requester),
    targetId: target.id,
    created: Date.now(),
  });
  REQUESTS.set(target.id, filtered);

  target.sendMessage(
    `§b[Teleport] ${getDisplayName(requester)} möchte sich zu dir teleportieren. Öffne das Menü mit einem Stock, um zu antworten.`
  );
  requester.sendMessage(`§a[Teleport] Anfrage an ${getDisplayName(target)} gesendet.`);
}

world.afterEvents.itemUse.subscribe((event) => {
  const { itemStack, source } = event;
  if (!(source instanceof Player)) return;
  if (!itemStack || itemStack.typeId !== TRIGGER_ITEM_ID) return;

  system.run(() => {
    openMainMenu(source).catch((error) => {
      console.warn(`Teleport-Menü konnte nicht geöffnet werden: ${error}`);
    });
  });
});

world.afterEvents.playerLeave.subscribe((event) => {
  const playerId = event.playerId;
  REQUESTS.delete(playerId);
  removeRequestsByRequester(playerId);
});

world.afterEvents.playerSpawn.subscribe((event) => {
  if (!event.initialSpawn) return;
  const player = event.player;
  player.sendMessage(
    "§b[Teleport] Nutze einen normalen Stock und interagiere, um das Teleport-Menü zu öffnen."
  );
});
