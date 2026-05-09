const MOD_ID = 'bg3-dialogue-system';

// Debug-Log Helfer
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

    // FIX: Wir bringen Foundry bei, wie der "add" Befehl im HTML funktioniert
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
        if (data.type === "showDialog" && game.user.id === data.receiverId) {
            new BG3DialogueWindow(data.npcId, data.options).render(true);
        } else if (data.type === "choiceMade" && game.user.isGM) {
            BG3DialogueSystem.processChoice(data);
        }
    });
});

// Scene Controls: Robuste Einbindung
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
            log(`Erstelle Ordner: ${folderName}`);
            folder = await Folder.create({ name: folderName, type: "Actor", color: "#c1a35b" });
        }

        let journal = game.journal.getName("lore-info");
        if (!journal) {
            log("Erstelle Lore-Journal...");
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
            const dialogData = JSON.parse(rawJson);
            game.socket.emit(`module.${MOD_ID}`, {
                type: "showDialog",
                npcId: npcId,
                receiverId: userId,
                options: dialogData.startNode
            });
            new BG3DialogueWindow(npcId, dialogData.startNode, true).render(true);
        } catch (e) {
            console.error("BG3-Dialog JSON Fehler:", e, "\nRohe Daten:", rawJson);
            ui.notifications.error("Die Biografie enthält kein valides JSON. Details in der Konsole (F12).");
        }
    }

    static processChoice(data) {
        const npc = game.actors.get(data.npcId);
        ChatMessage.create({
            content: `<b>${npc.name}:</b> ${data.text}`,
            speaker: { alias: npc.name }
        });
    }
}

class BG3DialogueWindow extends Application {
    constructor(npcId, data, isObserver = false) {
        super();
        this.npc = game.actors.get(npcId);
        this.dialogData = data;
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
        return {
            npcName: this.npc.name,
            npcImg: this.npc.img,
            text: this.dialogData.text,
            options: this.dialogData.options,
            isObserver: this.isObserver
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find('.dialog-option').click(ev => {
            if (this.isObserver) return;
            const idx = $(ev.currentTarget).data('index');
            const selected = this.dialogData.options[idx];
            
            game.socket.emit(`module.${MOD_ID}`, {
                type: "choiceMade",
                npcId: this.npc.id,
                text: selected.text
            });
            this.close();
        });
    }
}