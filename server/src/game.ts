// noinspection ES6PreferShortImport
import { Config, SpawnMode } from "./config";

import type { WebSocket } from "uWebSockets.js";

import { allowJoin, createNewGame, endGame, type PlayerContainer } from "./server";
import { Map } from "./map";
import { Gas } from "./gas";

import { Player } from "./objects/player";
import { Explosion } from "./objects/explosion";
import { removeFrom } from "./utils/misc";

import { UpdatePacket } from "./packets/sending/updatePacket";
import { type GameObject } from "./types/gameObject";

import { log } from "../../common/src/utils/misc";
import { OBJECT_ID_BITS, ObjectCategory, SERVER_GRID_SIZE, TICK_SPEED } from "../../common/src/constants";
import { ObjectType } from "../../common/src/utils/objectType";
import { Bullet, type DamageRecord } from "./objects/bullet";
import { KillFeedPacket } from "./packets/sending/killFeedPacket";
import { JoinKillFeedMessage } from "./types/killFeedMessage";
import { random, randomPointInsideCircle } from "../../common/src/utils/random";
import { JoinedPacket } from "./packets/sending/joinedPacket";
import { v, vClone, type Vector } from "../../common/src/utils/vector";
import { distanceSquared } from "../../common/src/utils/math";
import { MapPacket } from "./packets/sending/mapPacket";
import { Loot } from "./objects/loot";
import { IDAllocator } from "./utils/idAllocator";
import { type LootDefinition } from "../../common/src/definitions/loots";
import { GameOverPacket } from "./packets/sending/gameOverPacket";
import { SuroiBitStream } from "../../common/src/utils/suroiBitStream";
import { type GunItem } from "./inventory/gunItem";
import { type Emote } from "./objects/emote";
import { Building } from "./objects/building";
import { type DynamicBody } from "./physics/dynamicBody";

export class Game {
    readonly _id: number;
    get id(): number { return this._id; }

    map: Map;

    /**
     * A cached map packet
     * Since the map is static, there's no reason to serialize a map packet for each player that joins the game
     */
    private readonly mapPacketStream: SuroiBitStream;

    /**
     * The value of `Date.now()`, as of the start of the tick.
     */
    _now = Date.now();
    get now(): number { return this._now; }

    /**
     * A Set of all the static objects in the world
     */
    readonly staticObjects = new Set<GameObject>();
    /**
     * A Set of all the dynamic (moving) objects in the world
     */
    readonly dynamicObjects = new Set<GameObject>();
    readonly visibleObjects: Record<number, Record<number, Record<number, Set<GameObject>>>> = {};
    updateObjects = false;

    aliveCountDirty = false;

    readonly partialDirtyObjects = new Set<GameObject>();
    readonly fullDirtyObjects = new Set<GameObject>();
    readonly deletedObjects = new Set<GameObject>();

    readonly livingPlayers: Set<Player> = new Set<Player>();
    readonly connectedPlayers: Set<Player> = new Set<Player>();
    readonly spectatablePlayers: Player[] = [];

    readonly loot: Set<Loot> = new Set<Loot>();
    readonly explosions: Set<Explosion> = new Set<Explosion>();
    readonly emotes: Set<Emote> = new Set<Emote>();
    /**
     * All bullets that currently exist
     */
    readonly bullets = new Set<Bullet>();
    /**
     * All bullets created this tick
     */
    readonly newBullets = new Set<Bullet>();

    readonly dynamicBodies = new Set<DynamicBody>();

    /**
     * All kill feed messages this tick
     */
    readonly killFeedMessages = new Set<KillFeedPacket>();

    private _started = false;
    allowJoin = false;
    private _over = false;
    stopped = false;

    startTimeoutID?: NodeJS.Timeout;

    gas: Gas;

    tickTimes: number[] = [];

    tickDelta = 1000 / TICK_SPEED;

    constructor(id: number) {
        this._id = id;

        // Generate map
        this.map = new Map(this, Config.mapName);

        const mapPacket = new MapPacket(this);
        this.mapPacketStream = SuroiBitStream.alloc(mapPacket.allocBytes);
        mapPacket.serialize(this.mapPacketStream);

        this.gas = new Gas(this);

        this.allowJoin = true;

        // Start the tick loop
        this.tick(TICK_SPEED);
    }

    tick(delay: number): void {
        setTimeout((): void => {
            this._now = Date.now();

            if (this.stopped) return;

            // Update physics
            for (const body of this.dynamicBodies) body.tick();

            // Update loot positions
            for (const loot of this.loot) {
                if (loot.oldPosition.x !== loot.position.x || loot.oldPosition.y !== loot.position.y) {
                    this.partialDirtyObjects.add(loot);
                }
                loot.oldPosition = vClone(loot.position);
            }

            // Update bullets
            let records: DamageRecord[] = [];
            for (const bullet of this.bullets) {
                records = records.concat(bullet.update());

                if (bullet.dead) this.bullets.delete(bullet);
            }

            // Do the damage after updating all bullets
            // This is to make sure bullets that hit the same object on the same tick will die so they don't de-sync with the client
            // Example: a shotgun insta killing a crate, in the client all bullets will hit the crate
            // while on the server, without this, some bullets won't because the first bullets will kill the crate
            for (const record of records) {
                record.object.damage(record.damage, record.source, record.weapon);
            }

            // Handle explosions
            for (const explosion of this.explosions) {
                explosion.explode();
            }

            // Update gas
            this.gas.tick();

            // First loop over players: Movement, animations, & actions
            for (const player of this.livingPlayers) {
                // This system allows opposite movement keys to cancel each other out.
                const movement = v(0, 0);

                if (player.isMobile && player.movement.moving) {
                    movement.x = Math.cos(player.movement.angle) * 1.45;
                    movement.y = Math.sin(player.movement.angle) * 1.45;
                } else {
                    if (player.movement.up) movement.y--;
                    if (player.movement.down) movement.y++;
                    if (player.movement.left) movement.x--;
                    if (player.movement.right) movement.x++;
                }

                if (movement.x * movement.y !== 0) { // If the product is non-zero, then both of the components must be non-zero
                    movement.x *= Math.SQRT1_2;
                    movement.y *= Math.SQRT1_2;
                }

                /*if (this.emotes.size > 0) {
                    player.fast = !player.fast;
                    if (player.fast) {
                        player.loadout.skin = ObjectType.fromString(ObjectCategory.Loot, "hasanger");
                        player.fullDirtyObjects.add(player);
                        this.fullDirtyObjects.add(player);
                    } else {
                        player.loadout.skin = ObjectType.fromString(ObjectCategory.Loot, "debug");
                        player.fullDirtyObjects.add(player);
                        this.fullDirtyObjects.add(player);
                    }
                }
                if (player.fast) speed *= 30;*/

                const speed = player.calculateSpeed();
                player.body.velocity = v(movement.x * speed, movement.y * speed);

                if (player.isMoving || player.turning) {
                    player.disableInvulnerability();
                    this.partialDirtyObjects.add(player);
                }

                // Drain adrenaline
                if (player.adrenaline > 0) {
                    player.adrenaline -= 0.015;
                }

                // Regenerate health
                if (player.adrenaline >= 87.5) player.health += 2.75 / this.tickDelta;
                else if (player.adrenaline >= 50) player.health += 2.125 / this.tickDelta;
                else if (player.adrenaline >= 25) player.health += 1.125 / this.tickDelta;
                else if (player.adrenaline > 0) player.health += 0.625 / this.tickDelta;

                // Shoot gun/use melee
                if (player.startedAttacking) {
                    player.startedAttacking = false;
                    player.disableInvulnerability();
                    player.activeItem?.useItem();
                }

                // Gas damage
                if (this.gas.doDamage && this.gas.isInGas(player.position)) {
                    player.piercingDamage(this.gas.dps, "gas");
                }

                let isInsideBuilding = false;
                for (const object of player.nearObjects) {
                    if (object instanceof Building && !object.dead) {
                        if (object.scopeHitbox.collidesWith(player.body.hitbox)) {
                            isInsideBuilding = true;
                            break;
                        }
                    }
                }
                if (isInsideBuilding && !player.isInsideBuilding) {
                    player.zoom = 48;
                } else if (!player.isInsideBuilding) {
                    player.zoom = player.inventory.scope.definition.zoomLevel;
                }
                player.isInsideBuilding = isInsideBuilding;

                player.turning = false;
            }

            // Second loop over players: calculate visible objects & send updates
            for (const player of this.connectedPlayers) {
                if (!player.joined) continue;

                // Calculate visible objects
                if (player.movesSinceLastUpdate > 8 || this.updateObjects) {
                    player.updateVisibleObjects();
                }

                // Full objects
                if (this.fullDirtyObjects.size !== 0) {
                    for (const object of this.fullDirtyObjects) {
                        if (player.visibleObjects.has(object)) {
                            player.fullDirtyObjects.add(object);
                        }
                    }
                }

                // Partial objects
                if (this.partialDirtyObjects.size !== 0) {
                    for (const object of this.partialDirtyObjects) {
                        if (player.visibleObjects.has(object) && !player.fullDirtyObjects.has(object)) {
                            player.partialDirtyObjects.add(object);
                        }
                    }
                }

                // Deleted objects
                if (this.deletedObjects.size !== 0) {
                    for (const object of this.deletedObjects) {
                        if (player.visibleObjects.has(object) && object !== player) {
                            player.deletedObjects.add(object);
                        }
                    }
                }

                // Emotes
                if (this.emotes.size !== 0) {
                    for (const emote of this.emotes) {
                        if (player.visibleObjects.has(emote.player)) {
                            player.emotes.add(emote);
                        }
                    }
                }

                for (const message of this.killFeedMessages) player.sendPacket(message);
                if (player.spectating === undefined) {
                    const updatePacket = new UpdatePacket(player);
                    const updateStream = SuroiBitStream.alloc(updatePacket.allocBytes);
                    updatePacket.serialize(updateStream);
                    player.sendData(updateStream);
                    for (const spectator of player.spectators) {
                        spectator.sendData(updateStream);
                    }
                }
            }

            // Reset everything
            this.fullDirtyObjects.clear();
            this.partialDirtyObjects.clear();
            this.deletedObjects.clear();
            this.newBullets.clear();
            this.explosions.clear();
            this.emotes.clear();
            this.killFeedMessages.clear();
            this.aliveCountDirty = false;
            this.gas.dirty = false;
            this.gas.percentageDirty = false;
            this.updateObjects = false;

            for (const player of this.livingPlayers) {
                player.hitEffect = false;
                player.dirty.action = false;
            }

            // Winning logic
            if (this._started && this.aliveCount < 2 && !this._over) {
                // Send game over packet to the last man standing
                if (this.aliveCount === 1) {
                    const lastManStanding = [...this.livingPlayers][0];
                    lastManStanding.movement.up = false;
                    lastManStanding.movement.down = false;
                    lastManStanding.movement.left = false;
                    lastManStanding.movement.right = false;
                    lastManStanding.attacking = false;
                    lastManStanding.sendPacket(new GameOverPacket(lastManStanding, true));
                }

                // End the game in 1 second
                this.allowJoin = false;
                this._over = true;
                setTimeout(() => {
                    endGame(this._id); // End this game
                    const otherID = this._id === 0 ? 1 : 0; // == 1 - this.id
                    if (!allowJoin(otherID)) createNewGame(this._id); // Create a new game if the other game isn't allowing players to join
                }, 1000);
            }

            // Record performance and start the next tick
            // THIS TICK COUNTER IS WORKING CORRECTLY!
            // It measures the time it takes to calculate a tick, not the time between ticks.
            const tickTime = Date.now() - this.now;
            this.tickTimes.push(tickTime);

            if (this.tickTimes.length >= 200) {
                const mspt = this.tickTimes.reduce((a, b) => a + b) / this.tickTimes.length;

                log(`Game #${this._id} average ms/tick: ${mspt}`, true);
                log(`Load: ${((mspt / TICK_SPEED) * 100).toFixed(1)}%`);
                this.tickTimes = [];
            }

            this.tick(Math.max(0, TICK_SPEED - tickTime));
        }, delay);
    }

    addPlayer(socket: WebSocket<PlayerContainer>): Player {
        let spawnPosition = v(0, 0);
        switch (Config.spawn.mode) {
            case SpawnMode.Random: {
                let foundPosition = false;
                while (!foundPosition) {
                    spawnPosition = this.map.getRandomPositionFor(ObjectType.categoryOnly(ObjectCategory.Player));
                    if (!(distanceSquared(spawnPosition, this.gas.currentPosition) >= this.gas.newRadius ** 2)) foundPosition = true;
                }
                break;
            }
            case SpawnMode.Fixed: {
                spawnPosition = Config.spawn.position;
                break;
            }
            case SpawnMode.Radius: {
                spawnPosition = randomPointInsideCircle(Config.spawn.position, Config.spawn.radius);
                break;
            }
        }

        // Player is added to the players array when a JoinPacket is received from the client
        return new Player(this, socket, spawnPosition);
    }

    // Called when a JoinPacket is sent by the client
    activatePlayer(player: Player): void {
        const game = player.game;

        game.livingPlayers.add(player);
        game.spectatablePlayers.push(player);
        game.connectedPlayers.add(player);
        game.dynamicObjects.add(player);
        game.fullDirtyObjects.add(player);
        game.updateObjects = true;
        game.aliveCountDirty = true;
        game.killFeedMessages.add(new KillFeedPacket(player, new JoinKillFeedMessage(player, true)));

        player.updateVisibleObjects();
        player.joined = true;
        player.sendPacket(new JoinedPacket(player));
        player.sendData(this.mapPacketStream);

        setTimeout(() => {
            player.disableInvulnerability();
        }, 5000);

        if (this.aliveCount > 1 && !this._started && this.startTimeoutID === undefined) {
            this.startTimeoutID = setTimeout(() => {
                this._started = true;
                this.gas.advanceGas();
            }, 5000);
        }
    }

    /**
     * Get the visible objects at a given position and zoom level
     * @param position The position
     * @param zoom The zoom level, defaults to 48
     * @returns A set with the visible game objects at the given position and zoom level
     * @throws {Error} If the zoom level is invalid
     */
    getVisibleObjects(position: Vector, zoom = 48): Set<GameObject> {
        if (this.visibleObjects[zoom] === undefined) throw new Error(`Invalid zoom level: ${zoom}`);
        // return an empty set if the position is out of bounds
        if (position.x < 0 || position.x > this.map.width ||
            position.y < 0 || position.y > this.map.height) return new Set();
        /* eslint-disable no-unexpected-multiline */
        return this.visibleObjects[zoom]
            [Math.round(position.x / SERVER_GRID_SIZE) * SERVER_GRID_SIZE]
            [Math.round(position.y / SERVER_GRID_SIZE) * SERVER_GRID_SIZE];
    }

    removePlayer(player: Player): void {
        player.disconnected = true;
        this.aliveCountDirty = true;
        if (!player.dead) {
            this.killFeedMessages.add(new KillFeedPacket(player, new JoinKillFeedMessage(player, false)));
        }
        this.connectedPlayers.delete(player);
        // TODO Make it possible to spectate disconnected players
        // (currently not possible because update packets aren't sent to disconnected players)
        removeFrom(this.spectatablePlayers, player);
        if (player.canDespawn) {
            this.livingPlayers.delete(player);
            this.dynamicObjects.delete(player);
            this.removeObject(player);
        } else {
            player.rotation = 0;
            player.movement.up = player.movement.down = player.movement.left = player.movement.right = false;
            player.attacking = false;
            this.partialDirtyObjects.add(player);
        }
        if (this.aliveCount > 0 && player.spectators.size > 0) {
            if (this.spectatablePlayers.length > 1) {
                const randomPlayer = this.spectatablePlayers[random(0, this.spectatablePlayers.length - 1)];
                for (const spectator of player.spectators) {
                    spectator.spectate(randomPlayer);
                }
            }
            player.spectators = new Set<Player>();
        }
        if (player.spectating !== undefined) {
            player.spectating.spectators.delete(player);
        }
        if (this.aliveCount < 2) {
            clearTimeout(this.startTimeoutID);
            this.startTimeoutID = undefined;
        }
        try {
            player.socket.close();
        } catch (e) {}
    }

    addLoot(type: ObjectType<ObjectCategory.Loot, LootDefinition>, position: Vector, count?: number): Loot {
        const loot = new Loot(this, type, position, count);
        this.loot.add(loot);
        this.dynamicObjects.add(loot);
        this.fullDirtyObjects.add(loot);
        this.updateObjects = true;
        return loot;
    }

    removeLoot(loot: Loot): void {
        loot.dead = true;
        this.loot.delete(loot);
        this.dynamicObjects.delete(loot);
        this.removeObject(loot);
    }

    addBullet(position: Vector, rotation: number, source: GunItem, shooter: Player, reflectCount?: number, reflectedFromID?: number): Bullet {
        const bullet = new Bullet(
            this,
            position,
            rotation,
            source,
            shooter,
            reflectCount,
            reflectedFromID
        );
        this.bullets.add(bullet);
        this.newBullets.add(bullet);

        return bullet;
    }

    addExplosion(type: string, position: Vector, source: GameObject): Explosion {
        const explosion = new Explosion(this, ObjectType.fromString(ObjectCategory.Explosion, type), position, source);
        this.explosions.add(explosion);
        return explosion;
    }

    /**
     * Delete an object and give the id back to the allocator
     * @param object The object to delete
     */
    removeObject(object: GameObject): void {
        this.idAllocator.give(object.id);
        this.updateObjects = true;
    }

    get aliveCount(): number {
        return this.livingPlayers.size;
    }

    idAllocator = new IDAllocator(OBJECT_ID_BITS);

    get nextObjectID(): number {
        return this.idAllocator.takeNext();
    }
}
