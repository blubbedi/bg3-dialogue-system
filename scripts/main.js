const MOD_ID = 'bg3-dialogue-system';

function log(msg) { console.log(`BG3-DIALOG | ${msg}`); }

Hooks.once('init', () => {
    log("Initialisiere Einstellungen...");
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
    log("Foundry bereit. Prüfe Standard-Ordner...");
    if (game.user.isGM) {
        await BG3DialogueSystem.checkAndCreateDefaults();
    }

    game.socket.on(`module.${MOD_ID}`, data => {
        // Spieler erhält den Dialog-Baum und öffnet ihn
        if (data.type === "showDialog" && game.user.id === data.receiverId) {
            new BG3DialogueWindow(data.npcId, data.fullTree, data.startNode).render(true);
        } 
        // GM postet die Antwort des Spielers in den Chat
        else if (data.type === "choiceMade" && game.user.isGM) {
            BG3DialogueSystem.processChoice(data);
        } 
        // GM aktualisiert sein Beobachter-Fenster
        else if (data.type === "updateObserver" && game.user.isGM) {
            const openApp = Object.values(ui.windows).find(app => app instanceof BG3DialogueWindow && app.npc.id === data.npcId && app.isObserver);
            if (openApp) {
                openApp.currentNodeKey = data.nextNode;
                openApp.render(true);
            }
        } 
        // GM schließt sein Beobachter-Fenster
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

        let journal = game.journal.getName("lore-info");
        if (!journal) {
            await JournalEntry.create({
                name: "lore-info",
                pages: [{ name: "Welt-Aufzeichnungen", type: "text", text: { content: "Hier Lore eintragen." }}]
            });
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
        let playerOptions = players.map(p => `<option value="${p.id}">${p.name}</option>`).join("");

        new Dialog({
            title: "BG3 Konfigurator",
            content: `<form><div class="form-group"><label>NSC:</label><select name="npcId">${npcOptions}</select></div>
                      <div class="form-group"><label>Spieler:</label><select name="playerId">${playerOptions}</select></div></form>`,
            buttons: {
                start: { 
                    label: "Senden", 
                    callback: (html) => {
                        this.initiateDialogue(html.find('[name="npcId"]').val(), html.find('[name="playerId"]').val());
                    } 
                }
            }
        }).render(true);
    }

    static async initiateDialogue(npcId, userId) {
        const npc = game.actors.get(npcId);
        const bioHtml = npc.system.details.biography.value || "";
        
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = bioHtml;
        const rawJson = (tempDiv.textContent || tempDiv.innerText || "").trim();
        
        try {
            const fullTree = JSON.parse(rawJson);
            // Sende den KOMPLETTEN Baum an den Spieler
            game.socket.emit(`module.${MOD_ID}`, {
                type: "showDialog",
                npcId: npcId,
                receiverId: userId,
                fullTree: fullTree,
                startNode: "startNode"
            });
            // GM öffnet sein Fenster mit dem kompletten Baum
            new BG3DialogueWindow(npcId, fullTree, "startNode", true).render(true);
        } catch (e) {
            ui.notifications.error("Die Biografie enthält kein valides JSON.");
        }
    }

    static processChoice(data) {
        const npc = game.actors.get(data.npcId);
        const player = game.users.get(data.playerId);
        const playerName = player ? player.name : "Spieler";
        
        ChatMessage.create({
            content: `<span style="color: #c1a35b; font-size: 0.9em;">[Gespräch mit ${npc.name}]</span><br><b>${playerName}:</b> ${data.text}`
        });
    }
}

class BG3DialogueWindow extends Application {
    constructor(npcId, fullTree, currentNodeKey, isObserver = false) {
        super();
        this.npc = game.actors.get(npcId);
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
            
            // Postet die Entscheidung in den Chat
            game.socket.emit(`module.${MOD_ID}`, {
                type: "choiceMade",
                npcId: this.npc.id,
                playerId: game.user.id,
                text: selected.text
            });

            // Prüfen, ob es einen Folge-Knoten gibt
            if (selected.nextNode && this.fullTree[selected.nextNode]) {
                // Lokales Update für den Spieler
                this.currentNodeKey = selected.nextNode;
                this.render(true);

                // Update-Signal an den GM senden
                game.socket.emit(`module.${MOD_ID}`, {
                    type: "updateObserver",
                    npcId: this.npc.id,
                    nextNode: selected.nextNode
                });
            } else {
                // Kein Folge-Knoten = Gespräch beenden
                game.socket.emit(`module.${MOD_ID}`, {
                    type: "closeObserver",
                    npcId: this.npc.id
                });
                this.close();
            }
        });
    }
}