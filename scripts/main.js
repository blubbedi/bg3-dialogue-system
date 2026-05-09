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

Hooks.once('ready', () => {
    // Socket Listener für Spieler-Interaktion
    game.socket.on(`module.${MOD_ID}`, data => {
        if (data.type === "showDialog") {
            new BG3DialogueWindow(data.npcId, data.options).render(true);
        } else if (data.type === "choiceMade" && game.user.isGM) {
            BG3DialogueSystem.processChoice(data);
        }
    });
});

class BG3DialogueSystem {
    /**
     * Startet das Gespräch (GM-Aktion)
     */
    static async initiateDialogue(npcId, userId) {
        const npc = game.actors.get(npcId);
        const loreJournal = game.journal.getName("lore-info");
        const loreContent = loreJournal ? loreJournal.pages.contents.map(p => p.text.content).join(" ") : "";

        // Einfache Logik: Wir parsen die Bio des NSC nach verfügbaren Nodes
        const dialogData = JSON.parse(npc.system.details.biography.value || "{}");
        
        const payload = {
            type: "showDialog",
            npcId: npcId,
            options: dialogData.startNode,
            loreContext: loreContent
        };

        game.socket.emit(`module.${MOD_ID}`, payload);
        // Auch für den GM zum Mitlesen öffnen
        new BG3DialogueWindow(npcId, dialogData.startNode, true).render(true);
    }

    static processChoice(data) {
        const npc = game.actors.get(data.npcId);
        // Logik für den nächsten Knotenpunkt und Chat-Ausgabe
        const message = `<b>${npc.name}:</b> ${data.text}`;
        ChatMessage.create({ content: message });
    }
}

class BG3DialogueWindow extends Application {
    constructor(npcId, currentData, isObserver = false) {
        super();
        this.npc = game.actors.get(npcId);
        this.data = currentData;
        this.isObserver = isObserver;
    }

    static get defaultOptions() {
        return mergeObject(super.defaultOptions, {
            id: "bg3-dialog-ui",
            template: `modules/${MOD_ID}/templates/dialog.html`,
            popOut: true,
            resizable: false,
            width: 800,
            height: "auto"
        });
    }

    getData() {
        return {
            npcName: this.npc.name,
            npcImg: this.npc.img,
            text: this.data.text,
            options: this.data.options,
            isObserver: this.isObserver
        };
    }

    activateListeners(html) {
        html.find('.dialog-option').click(ev => {
            if (this.isObserver) return;
            const idx = $(ev.currentTarget).data('index');
            const choice = this.data.options[idx];
            
            game.socket.emit(`module.${MOD_ID}`, {
                type: "choiceMade",
                npcId: this.npc.id,
                text: choice.text,
                nextNode: choice.nextNode
            });
            this.close();
        });
    }
}

// GM Tool: Button im Actor-Directory um Gespräch zu starten
Hooks.on('getActorDirectoryEntryContext', (html, options) => {
    options.push({
        name: "BG3 Gespräch starten",
        icon: '<i class="fas fa-comments"></i>',
        condition: li => game.user.isGM,
        callback: li => {
            const actorId = li.data('document-id');
            BG3DialogueSystem.showStarterMenu(actorId);
        }
    });
});