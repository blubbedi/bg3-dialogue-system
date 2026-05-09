const MOD_ID = 'bg3-dialogue-system';

function log(msg) { console.log(`BG3-DIALOG | ${msg}`); }

Hooks.once('init', () => {
    game.settings.register(MOD_ID, 'npcFolder', {
        name: "NPC-Ordner Name",
        scope: "world",
        config: true,
        type: String,
        default: "BG3-Dialogue-NPCs"
    });

    Handlebars.registerHelper('add', function(a, b) {
        return Number(a) + Number(b);
    });
});

Hooks.once('ready', async () => {
    if (game.user.isGM) {
        await BG3DialogueSystem.checkAndCreateDefaults();
    }

    game.socket.on(`module.${MOD_ID}`, data => {
        // 1. Spieler öffnet das Fenster
        if (data.type === "showDialog" && game.user.id === data.receiverId) {
            new BG3DialogueWindow(data.npcId, data.pcId, data.fullTree, data.startNode).render(true);
        } 
        // 2. Nur der *aktive* GM verarbeitet die Chat-Nachrichten, um doppelte Posts zu vermeiden
        else if (data.type === "choiceMade" && game.user.isGM && game.users.activeGM?.isSelf) {
            BG3DialogueSystem.processChoice(data);
        } 
        // 3. GM aktualisiert sein Beobachter-Fenster
        else if (data.type === "updateObserver" && game.user.isGM) {
            const openApp = Object.values(ui.windows).find(app => app instanceof BG3DialogueWindow && app.npc.id === data.npcId && app.isObserver);
            if (openApp) {
                openApp.currentNodeKey = data.nextNode;
                openApp.render(true);
            }
        } 
        // 4. GM schließt sein Beobachter-Fenster
        else if (data.type === "closeObserver" && game.user.isGM) {
            const openApp = Object.values(ui.windows).find(app => app instanceof BG3DialogueWindow && app.npc.id === data.npcId && app.isObserver);
            if (openApp) openApp.close();
        }
    });
});

Hooks.on('getSceneControlButtons', (controls) => {
    if (!game.user.isGM) return;
    const tokenControl = controls.find(c => c.name === "token");
    if (tokenControl) {
        tokenControl.tools.push({
            name: "start-bg3-conv",
            title: "BG3 Gespräch starten",
            icon: "fas fa-comments",
            onClick: () => BG3DialogueSystem.showSelectionDialog(),
            button: true
        });
    }
});

class BG3DialogueSystem {
    static async checkAndCreateDefaults() {
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        let folder = game.folders.find(f => f.name === folderName && f.type === "Actor");
        if (!folder) {
            folder = await Folder.create({ name: folderName, type: "Actor", color: "#c1a35b" });
        }
    }

    static showSelectionDialog() {
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        const folder = game.folders.find(f => f.name === folderName && f.type === "Actor");
        if (!folder) return ui.notifications.error(`Ordner '${folderName}' fehlt.`);

        const npcs = game.actors.filter(a => a.folder?.id === folder.id);
        const players = game.users.filter(u => u.active && !u.isGM);

        if (npcs.length === 0) return ui.notifications.warn("Keine NPCs im BG3-Ordner.");
        if (players.length === 0) return ui.notifications.warn("Keine Spieler online.");

        let npcOptions = npcs.map(n => `<option value="${n.id}">${n.name}</option>`).join("");
        let playerOptions = players.map(p => `<option value="${p.id}">${p.name} (${p.character?.name || "Kein Char"})</option>`).join("");

        new Dialog({
            title: "BG3 Konfigurator",
            content: `<form><div class="form-group"><label>NSC:</label><select name="npcId">${npcOptions}</select></div>
                      <div class="form-group"><label>Spieler:</label><select name="playerId">${playerOptions}</select></div></form>`,
            buttons: {
                start: { 
                    label: "Senden", 
                    callback: (html) => this.initiateDialogue(html.find('[name="npcId"]').val(), html.find('[name="playerId"]').val())
                }
            }
        }).render(true);
    }

    static async initiateDialogue(npcId, userId) {
        const npc = game.actors.get(npcId);
        const user = game.users.get(userId);
        const pc = user?.character; // Greift den Charakter des Spielers ab
        const pcId = pc ? pc.id : null;
        
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = npc.system.details.biography.value || "";
        const rawJson = (tempDiv.textContent || tempDiv.innerText || "").trim();
        
        try {
            const fullTree = JSON.parse(rawJson);
            
            // 1. Die erste Begrüßung des NPCs in den Chat posten
            ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: npc }),
                content: `<div class="bg3-chat-msg npc-msg"><b>${npc.name}:</b> ${fullTree.startNode.text}</div>`
            });

            // 2. Den Dialog an den Spieler senden
            game.socket.emit(`module.${MOD_ID}`, {
                type: "showDialog",
                npcId: npcId,
                pcId: pcId,
                receiverId: userId,
                fullTree: fullTree,
                startNode: "startNode"
            });
            
            // 3. GM öffnet sein Fenster
            new BG3DialogueWindow(npcId, pcId, fullTree, "startNode", true).render(true);
        } catch (e) {
            ui.notifications.error("Die Biografie enthält kein valides JSON.");
        }
    }

    static processChoice(data) {
        const npc = game.actors.get(data.npcId);
        const pc = data.pcId ? game.actors.get(data.pcId) : null;
        
        // Nutzt Charakter-Daten, falls vorhanden. Sonst Spieler-Daten.
        const speakerName = pc ? pc.name : (game.users.get(data.playerId)?.name || "Unbekannt");
        const speakerData = pc ? ChatMessage.getSpeaker({ actor: pc }) : { alias: speakerName };

        // 1. Die Antwort des Spielers/Charakters posten
        ChatMessage.create({
            speaker: speakerData,
            content: `<div class="bg3-chat-msg pc-msg"><b>${speakerName}:</b> ${data.text}</div>`
        });

        // 2. Die direkte Antwort des NPCs posten (falls der Dialog weitergeht)
        if (data.nextNodeText) {
            ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: npc }),
                content: `<div class="bg3-chat-msg npc-msg"><b>${npc.name}:</b> ${data.nextNodeText}</div>`
            });
        }
    }
}

class BG3DialogueWindow extends Application {
    constructor(npcId, pcId, fullTree, currentNodeKey, isObserver = false) {
        super();
        this.npc = game.actors.get(npcId);
        this.pc = pcId ? game.actors.get(pcId) : null;
        this.fullTree = fullTree;
        this.currentNodeKey = currentNodeKey;
        this.isObserver = isObserver;
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "bg3-dialog-ui",
            template: `modules/${MOD_ID}/templates/dialog.html`,
            width: 700,
            height: "auto",
            popOut: true,
            title: "Gespräch"
        });
    }

    getData() {
        const node = this.fullTree[this.currentNodeKey];
        return {
            npcName: this.npc.name,
            npcImg: this.npc.img,
            pcName: this.pc ? this.pc.name : null,
            pcImg: this.pc ? this.pc.img : null,
            text: node ? node.text : "...",
            options: node && node.options ? node.options : [],
            isObserver: this.isObserver
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find('.dialog-option').click(ev => {
            if (this.isObserver) return;
            
            const idx = $(ev.currentTarget).data('index');
            const node = this.fullTree[this.currentNodeKey];
            const selected = node.options[idx];
            const nextNode = selected.nextNode ? this.fullTree[selected.nextNode] : null;
            
            // Signalisiert dem GM, die Chat-Nachrichten zu generieren
            game.socket.emit(`module.${MOD_ID}`, {
                type: "choiceMade",
                npcId: this.npc.id,
                pcId: this.pc ? this.pc.id : null,
                playerId: game.user.id,
                text: selected.text,
                nextNodeText: nextNode ? nextNode.text : null
            });

            if (nextNode) {
                this.currentNodeKey = selected.nextNode;
                this.render(true);
                game.socket.emit(`module.${MOD_ID}`, { type: "updateObserver", npcId: this.npc.id, nextNode: selected.nextNode });
            } else {
                game.socket.emit(`module.${MOD_ID}`, { type: "closeObserver", npcId: this.npc.id });
                this.close();
            }
        });
    }
}