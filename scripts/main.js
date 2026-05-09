const MOD_ID = 'bg3-dialogue-system';

Hooks.once('init', () => {
    game.settings.register(MOD_ID, 'npcFolder', {
        name: "NPC Folder Name",
        scope: "world",
        config: true,
        type: String,
        default: "BG3-Dialogue-NPCs"
    });
});

Hooks.once('ready', async () => {
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

// GUI Button in Scene Controls (Links)
Hooks.on('getSceneControlButtons', (controls) => {
    if (!game.user.isGM) return;
    controls.push({
        name: "bg3-dialogue",
        title: "BG3 Dialogue System",
        icon: "fas fa-comments",
        layer: "actors",
        visible: true,
        tools: [{
            name: "start-dialog",
            title: "Gespräch starten",
            icon: "fas fa-play",
            onClick: () => BG3DialogueSystem.showSelectionDialog(),
            button: true
        }]
    });
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
                pages: [{ name: "Welt-Aufzeichnungen", type: "text", text: { content: "Beispiel: Ishkandrael wurde gefunden." }}]
            });
        }

        let exampleNpc = game.actors.find(a => a.name === "Beispiel NSC" && a.folder?.id === folder.id);
        if (!exampleNpc) {
            const exampleDialog = {
                startNode: {
                    text: "Seid gegrüßt! Habt ihr das Schwert Ishkandrael schon gefunden?",
                    options: [
                        { text: "Ja, wir haben es.", nextNode: "success" },
                        { text: "Nein, noch nicht.", nextNode: "info" }
                    ]
                }
            };
            await Actor.create({
                name: "Beispiel NSC",
                type: "npc",
                folder: folder.id,
                system: { details: { biography: { value: JSON.stringify(exampleDialog, null, 2) }}}
            });
        }
    }

    static showSelectionDialog() {
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        const folder = game.folders.find(f => f.name === folderName && f.type === "Actor");
        const npcs = game.actors.filter(a => a.folder?.id === folder?.id);
        const players = game.users.filter(u => u.active && !u.isGM);

        if (!npcs.length || !players.length) return ui.notifications.warn("NSCs oder Spieler fehlen/offline.");

        const content = `
            <form><div class="form-group"><label>NSC:</label><select name="npcId">${npcs.map(n => `<option value="${n.id}">${n.name}</option>`).join("")}</select></div>
            <div class="form-group"><label>Spieler:</label><select name="playerId">${players.map(p => `<option value="${p.id}">${p.name}</option>`).join("")}</select></div></form>`;

        new Dialog({
            title: "BG3 Gespräch starten",
            content: content,
            buttons: {
                start: { label: "Senden", callback: (html) => this.initiateDialogue(html.find('[name="npcId"]').val(), html.find('[name="playerId"]').val()) }
            }
        }).render(true);
    }

    static async initiateDialogue(npcId, userId) {
        const npc = game.actors.get(npcId);
        const rawBio = npc.system.details.biography.value.replace(/(<([^>]+)>)/gi, "");
        const dialogData = JSON.parse(rawBio);

        game.socket.emit(`module.${MOD_ID}`, {
            type: "showDialog",
            npcId: npcId,
            receiverId: userId,
            options: dialogData.startNode
        });

        new BG3DialogueWindow(npcId, dialogData.startNode, true).render(true);
    }

    static processChoice(data) {
        const npc = game.actors.get(data.npcId);
        ChatMessage.create({ content: `<b>${npc.name}:</b> ${data.text}`, speaker: { alias: npc.name }});
    }
}

class BG3DialogueWindow extends Application {
    constructor(npcId, data, isObserver = false) {
        super();
        this.npc = game.actors.get(npcId);
        this.data = data;
        this.isObserver = isObserver;
    }

    static get defaultOptions() {
        return mergeObject(super.defaultOptions, {
            id: "bg3-dialog-ui",
            template: `modules/${MOD_ID}/templates/dialog.html`,
            width: 700,
            popOut: true
        });
    }

    getData() {
        return { npcName: this.npc.name, npcImg: this.npc.img, text: this.data.text, options: this.data.options, isObserver: this.isObserver };
    }

    activateListeners(html) {
        html.find('.dialog-option').click(ev => {
            if (this.isObserver) return;
            const idx = $(ev.currentTarget).data('index');
            game.socket.emit(`module.${MOD_ID}`, { type: "choiceMade", npcId: this.npc.id, text: this.data.options[idx].text });
            this.close();
        });
    }
}