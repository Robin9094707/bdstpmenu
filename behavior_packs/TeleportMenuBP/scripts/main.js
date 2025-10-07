import {
  DynamicPropertiesDefinition,
  EntityTypes,
  Player,
  system,
  world,
} from "@minecraft/server";
import { ActionFormData, MessageFormData, ModalFormData } from "@minecraft/server-ui";

const TRIGGER_ITEM_ID = "minecraft:stick";
const TITLE_PREFIX = "§b§lTeleport & Wegpunkte§r";
const WAYPOINT_PROPERTY = "tm_waypoints";
const MAX_WAYPOINTS = 20;
const MAX_NAME_LENGTH = 32;
const DIMENSION_OPTIONS = [
  {
    id: "minecraft:overworld",
    label: "§aOberwelt",
    icon: "textures/items/compass",
  },
  {
    id: "minecraft:nether",
    label: "§cNether",
    icon: "textures/items/blaze_powder",
  },
  {
    id: "minecraft:the_end",
    label: "§dDas Ende",
    icon: "textures/items/ender_pearl",
  },
];
const SOUND_OPEN = "ui.button.click";
const SOUND_SUCCESS = "random.orb";
const SOUND_ERROR = "note.bass";
const SOUND_DELETE = "random.anvil_land";

const REQUESTS = new Map();

world.afterEvents.worldInitialize.subscribe(({ propertyRegistry }) => {
  const definition = new DynamicPropertiesDefinition();
  definition.defineString(WAYPOINT_PROPERTY, 12000);
  propertyRegistry.registerEntityTypeDynamicProperties(
    definition,
    EntityTypes.get("minecraft:player")
  );
});

function getDisplayName(player) {
  if (!player) {
    return "Unbekannt";
  }
  const nameTag = (player.nameTag ?? "").trim();
  return nameTag.length > 0 ? nameTag : player.name;
}

function playSound(player, soundId) {
  try {
    player.playSound(soundId);
  } catch (error) {
    console.warn(`Sound ${soundId} konnte nicht abgespielt werden: ${error}`);
  }
}

function getDimensionOptionById(id) {
  return DIMENSION_OPTIONS.find((option) => option.id === id) ?? DIMENSION_OPTIONS[0];
}

function formatCoordinates(waypoint) {
  return `${Math.round(waypoint.x)}, ${Math.round(waypoint.y)}, ${Math.round(waypoint.z)}`;
}

function sanitizeName(raw) {
  const cleaned = (raw ?? "").trim();
  if (cleaned.length === 0) {
    return "";
  }
  return cleaned.length > MAX_NAME_LENGTH ? cleaned.substring(0, MAX_NAME_LENGTH) : cleaned;
}

function loadWaypoints(player) {
  const raw = player.getDynamicProperty(WAYPOINT_PROPERTY);
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => ({
        id: entry.id ?? `${Date.now()}-${Math.random()}`,
        name: sanitizeName(entry.name) || "Unbenannt",
        dimension: typeof entry.dimension === "string" ? entry.dimension : "minecraft:overworld",
        x: typeof entry.x === "number" ? entry.x : 0,
        y: typeof entry.y === "number" ? entry.y : 64,
        z: typeof entry.z === "number" ? entry.z : 0,
      }))
      .slice(0, MAX_WAYPOINTS);
  } catch (error) {
    console.warn(`Wegpunkte konnten nicht geladen werden: ${error}`);
    return [];
  }
}

function saveWaypoints(player, waypoints) {
  try {
    player.setDynamicProperty(WAYPOINT_PROPERTY, JSON.stringify(waypoints));
  } catch (error) {
    console.warn(`Wegpunkte konnten nicht gespeichert werden: ${error}`);
  }
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
  playSound(player, SOUND_OPEN);
  const form = new ActionFormData()
    .title(TITLE_PREFIX)
    .body("§7Verwalte deine Teleport-Anfragen und persönlichen Wegpunkte.")
    .button("§aWegpunkte öffnen\n§7Verwalten & teleportieren", "textures/items/map_filled")
    .button("§bWegpunkt erstellen\n§7Aktuelle Position speichern", "textures/items/compass")
    .button("§aTeleport-Anfrage senden", "textures/items/ender_pearl")
    .button("§eAnfragen verwalten", "textures/items/paper");

  const response = await form.show(player);
  if (response.canceled) return;

  switch (response.selection) {
    case 0:
      await openWaypointList(player);
      break;
    case 1:
      await promptCreateWaypoint(player);
      break;
    case 2:
      await openRequestMenu(player);
      break;
    case 3:
      await openPendingMenu(player);
      break;
  }
}

async function openWaypointList(player) {
  const waypoints = loadWaypoints(player);
  if (waypoints.length === 0) {
    player.sendMessage("§7[Wegpunkte] Du hast noch keine Wegpunkte gespeichert. Nutze §bWegpunkt erstellen§7.");
    playSound(player, SOUND_ERROR);
    return;
  }

  const form = new ActionFormData()
    .title(`${TITLE_PREFIX}\n§3Gespeicherte Wegpunkte`)
    .body(`§7Gespeichert: §b${waypoints.length}§7/§b${MAX_WAYPOINTS}`);

  for (const waypoint of waypoints) {
    const option = getDimensionOptionById(waypoint.dimension);
    const details = `${option.label} §f${formatCoordinates(waypoint)}`;
    form.button(`§b${waypoint.name}§r\n§7${details}`, option.icon);
  }

  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) {
    return;
  }

  const waypoint = waypoints[response.selection];
  if (!waypoint) {
    player.sendMessage("§c[Wegpunkte] Dieser Eintrag existiert nicht mehr.");
    return;
  }

  await openWaypointActions(player, waypoint.id);
}

async function openWaypointActions(player, waypointId) {
  const waypoints = loadWaypoints(player);
  const index = waypoints.findIndex((entry) => entry.id === waypointId);
  if (index === -1) {
    player.sendMessage("§c[Wegpunkte] Dieser Wegpunkt ist nicht mehr verfügbar.");
    return;
  }

  const waypoint = waypoints[index];
  const option = getDimensionOptionById(waypoint.dimension);

  const form = new ActionFormData()
    .title(`${TITLE_PREFIX}\n§b${waypoint.name}`)
    .body(`§7${option.label} §f${formatCoordinates(waypoint)}`)
    .button("§aTeleportieren", "textures/items/ender_pearl")
    .button("§eUmbenennen", "textures/items/name_tag")
    .button("§bPosition aktualisieren", "textures/items/recovery_compass")
    .button("§cLöschen", "textures/items/lava_bucket");

  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) {
    return;
  }

  switch (response.selection) {
    case 0:
      await teleportToWaypoint(player, waypoint);
      break;
    case 1:
      await promptRenameWaypoint(player, waypoints, index);
      break;
    case 2:
      await updateWaypointToCurrentPosition(player, waypoints, index);
      break;
    case 3:
      await confirmDeleteWaypoint(player, waypoints, index);
      break;
  }
}

async function teleportToWaypoint(player, waypoint) {
  const dimension = world.getDimension(waypoint.dimension);
  if (!dimension) {
    player.sendMessage("§c[Wegpunkte] Die Ziel-Dimension ist nicht verfügbar.");
    playSound(player, SOUND_ERROR);
    return;
  }

  try {
    player.teleport({ x: waypoint.x, y: waypoint.y, z: waypoint.z }, { dimension });
    player.sendMessage(
      `§a[Wegpunkte] Du wurdest zu §b${waypoint.name}§a teleportiert (${formatCoordinates(waypoint)}).`
    );
    playSound(player, SOUND_SUCCESS);
  } catch (error) {
    player.sendMessage(`§c[Wegpunkte] Teleport fehlgeschlagen: ${error}`);
    playSound(player, SOUND_ERROR);
  }
}

async function promptRenameWaypoint(player, waypoints, index) {
  const waypoint = waypoints[index];
  const modal = new ModalFormData()
    .title(`${TITLE_PREFIX}\n§eUmbenennen`)
    .textField("§bNeuer Name", "Zuhause", waypoint.name);

  const response = await modal.show(player);
  if (response.canceled) {
    return;
  }

  const [nameInput] = response.formValues;
  const newName = sanitizeName(nameInput);
  if (!newName) {
    player.sendMessage("§c[Wegpunkte] Der Name darf nicht leer sein.");
    playSound(player, SOUND_ERROR);
    return;
  }

  waypoint.name = newName;
  saveWaypoints(player, waypoints);
  player.sendMessage(`§a[Wegpunkte] Der Wegpunkt heißt jetzt §b${newName}§a.`);
  playSound(player, SOUND_SUCCESS);
  await openWaypointActions(player, waypoint.id);
}

async function updateWaypointToCurrentPosition(player, waypoints, index) {
  const waypoint = waypoints[index];
  const { x, y, z } = player.location;
  waypoint.x = x;
  waypoint.y = y;
  waypoint.z = z;
  waypoint.dimension = player.dimension.id;
  saveWaypoints(player, waypoints);
  player.sendMessage(
    `§a[Wegpunkte] Position von §b${waypoint.name}§a aktualisiert (${formatCoordinates(waypoint)}).`
  );
  playSound(player, SOUND_SUCCESS);
  await openWaypointActions(player, waypoint.id);
}

async function confirmDeleteWaypoint(player, waypoints, index) {
  const waypoint = waypoints[index];
  const prompt = new MessageFormData()
    .title(`${TITLE_PREFIX}\n§cWegpunkt löschen`)
    .body(`§7Möchtest du §c${waypoint.name}§7 dauerhaft entfernen?`)
    .button1("§cAbbrechen")
    .button2("§aLöschen");

  const response = await prompt.show(player);
  if (response.canceled || response.selection !== 1) {
    return;
  }

  waypoints.splice(index, 1);
  saveWaypoints(player, waypoints);
  player.sendMessage(`§c[Wegpunkte] §c${waypoint.name}§7 wurde gelöscht.`);
  playSound(player, SOUND_DELETE);
}

async function promptCreateWaypoint(player) {
  const waypoints = loadWaypoints(player);
  if (waypoints.length >= MAX_WAYPOINTS) {
    player.sendMessage(
      `§c[Wegpunkte] Du kannst maximal §b${MAX_WAYPOINTS}§c Wegpunkte speichern.`
    );
    playSound(player, SOUND_ERROR);
    return;
  }

  const location = player.location;
  const baseName = `Wegpunkt ${waypoints.length + 1}`;
  const currentDimensionIndex = Math.max(
    0,
    DIMENSION_OPTIONS.findIndex((option) => option.id === player.dimension.id)
  );

  const modal = new ModalFormData()
    .title(`${TITLE_PREFIX}\n§bWegpunkt erstellen`)
    .textField("§bName", "Zuhause", baseName)
    .textField("§eX-Koordinate", "0", Math.round(location.x).toString())
    .textField("§eY-Koordinate", "64", Math.round(location.y).toString())
    .textField("§eZ-Koordinate", "0", Math.round(location.z).toString())
    .dropdown(
      "§bDimension",
      DIMENSION_OPTIONS.map((option) => option.label),
      currentDimensionIndex
    );

  const response = await modal.show(player);
  if (response.canceled) {
    return;
  }

  const [nameInput, xInput, yInput, zInput, dimensionIndex] = response.formValues;
  const name = sanitizeName(nameInput);
  const x = Number(xInput);
  const y = Number(yInput);
  const z = Number(zInput);
  const option = DIMENSION_OPTIONS[dimensionIndex] ?? DIMENSION_OPTIONS[0];

  if (!name) {
    player.sendMessage("§c[Wegpunkte] Der Name darf nicht leer sein.");
    playSound(player, SOUND_ERROR);
    return;
  }

  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
    player.sendMessage("§c[Wegpunkte] Koordinaten müssen Zahlen sein.");
    playSound(player, SOUND_ERROR);
    return;
  }

  waypoints.push({
    id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    name,
    dimension: option.id,
    x,
    y,
    z,
  });

  saveWaypoints(player, waypoints);
  player.sendMessage(
    `§a[Wegpunkte] §b${name}§a wurde gespeichert (${formatCoordinates({ x, y, z })} in ${option.label}).`
  );
  playSound(player, SOUND_SUCCESS);
}

async function openRequestMenu(requester) {
  const targets = [...world.getPlayers()].filter((player) => player.id !== requester.id);
  if (targets.length === 0) {
    requester.sendMessage("§7[Teleport] Keine anderen Spieler online.");
    playSound(requester, SOUND_ERROR);
    return;
  }

  const form = new ActionFormData()
    .title(`${TITLE_PREFIX}\n§aTeleport senden`)
    .body("§7Wähle einen Spieler, zu dem du dich teleportieren möchtest.");

  for (const target of targets) {
    form.button(`${getDisplayName(target)}`, "textures/items/ender_pearl");
  }

  const response = await form.show(requester);
  if (response.canceled || response.selection === undefined) {
    return;
  }

  const target = targets[response.selection];
  if (!target) {
    requester.sendMessage("§c[Teleport] Der Spieler ist nicht mehr verfügbar.");
    playSound(requester, SOUND_ERROR);
    return;
  }

  registerRequest(requester, target);
}

async function openPendingMenu(target) {
  const entries = [...(REQUESTS.get(target.id) ?? [])];
  if (entries.length === 0) {
    target.sendMessage("§7[Teleport] Keine offenen Anfragen.");
    playSound(target, SOUND_ERROR);
    return;
  }

  const form = new ActionFormData()
    .title(`${TITLE_PREFIX}\n§eAnfragen`)
    .body("§7Wähle eine Anfrage zum Bearbeiten aus.");

  for (const entry of entries) {
    form.button(`${entry.requesterName}`, "textures/items/paper");
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
    .title(`${TITLE_PREFIX}\n§eTeleport-Anfrage`)
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
    playSound(target, SOUND_ERROR);
    return;
  }

  if (accepted) {
    requester.teleport(target.location, {
      dimension: target.dimension,
    });
    requester.sendMessage(`§a[Teleport] ${getDisplayName(target)} hat deine Anfrage akzeptiert.`);
    target.sendMessage(`§a[Teleport] ${entry.requesterName} wurde zu dir teleportiert.`);
    playSound(requester, SOUND_SUCCESS);
    playSound(target, SOUND_SUCCESS);
  } else {
    requester.sendMessage(`§c[Teleport] ${getDisplayName(target)} hat deine Anfrage abgelehnt.`);
    target.sendMessage("§7[Teleport] Anfrage abgelehnt.");
    playSound(target, SOUND_ERROR);
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
  playSound(requester, SOUND_SUCCESS);
}

world.afterEvents.itemUse.subscribe((event) => {
  const { itemStack, source } = event;
  if (!(source instanceof Player)) return;
  if (!itemStack || itemStack.typeId !== TRIGGER_ITEM_ID) return;

  system.run(() => {
    openMainMenu(source).catch((error) => {
      console.warn(`Menü konnte nicht geöffnet werden: ${error}`);
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
    "§b[Teleport] Nutze einen normalen Stock, um das Menü für Wegpunkte und Teleport-Anfragen zu öffnen."
  );
  playSound(player, SOUND_OPEN);
});
