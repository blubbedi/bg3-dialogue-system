const MOD_ID = 'bg3-dialogue-system';

function dispatchSystemEvent(data) {
    if (game.user.isGM) {
        if (data.type === "choiceMade") BG3DialogueSystem.processChoice(data);
        else if (data.type === "closeObserver") BG3DialogueSystem.endConversation(data.npcId);
        else if (data.type === "updateRelationship") BG3DialogueSystem.updateRelationshipJournal(data.npcId, data.mod, data.tag);
    } else {
        game.socket.emit(`module.${MOD_ID}`, data);
    }
}

Hooks.once('init', () => {
    game.settings.register(MOD_ID, 'npcFolder', {
        name: "NPC-Ordner Name", scope: "world", config: true, type: String, default: "BG3-Dialogue-NPCs"
    });
    Handlebars.registerHelper('add', (a, b) => Number(a) + Number(b));
});

Hooks.once('ready', async () => {
    if (game.user.isGM) await BG3DialogueSystem.checkAndCreateDefaults();
    game.socket.on(`module.${MOD_ID}`, async data => {
        if (data.type === "showDialog" && game.user.id === data.receiverId) {
            new BG3DialogueWindow(data.npcId, data.pcId, data.fullTree, data.startNode, false, data.relScore, data.relTags).render(true);
        } else if (data.type === "choiceMade" && game.user.isGM) {
            await BG3DialogueSystem.processChoice(data);
        } else if (data.type === "updateObserver" && game.user.isGM) {
            const app = Object.values(ui.windows).find(a => a instanceof BG3DialogueWindow && a.npc.id === data.npcId && a.isObserver);
            if (app) { app.currentNodeKey = data.nextNode; app.relScore = data.relScore; app.relTags = data.relTags; app.render(true); }
        } else if (data.type === "closeObserver" && game.user.isGM) {
            await BG3DialogueSystem.endConversation(data.npcId);
        } else if (data.type === "updateRelationship" && game.user.isGM) {
            await BG3DialogueSystem.updateRelationshipJournal(data.npcId, data.mod, data.tag);
        }
    });
});

class BG3DialogueSystem {
    static activeSessions = {};

    static async checkAndCreateDefaults() {
        let parent = game.folders.find(f => f.name === "Gespräche" && f.type === "JournalEntry") || await Folder.create({ name: "Gespräche", type: "JournalEntry" });
        if (!game.folders.find(f => f.name === "Beziehung" && f.folder?.id === parent.id)) await Folder.create({ name: "Beziehung", type: "JournalEntry", folder: parent.id });
        if (!game.folders.find(f => f.name === "Logs" && f.folder?.id === parent.id)) await Folder.create({ name: "Logs", type: "JournalEntry", folder: parent.id });
    }

    static async getOrCreateRelationship(npcName) {
        let relFolder = game.folders.find(f => f.name === "Beziehung" && f.type === "JournalEntry");
        let report = game.journal.find(j => j.name === npcName && j.folder?.id === relFolder?.id);
        if (!report) {
            report = await JournalEntry.create({ name: npcName, folder: relFolder?.id, pages: [{ name: "Status", type: "text", text: { content: "..." } }] });
            await report.setFlag(MOD_ID, "relationshipScore", 0);
            await report.setFlag(MOD_ID, "tags", []);
        }
        return { score: report.getFlag(MOD_ID, "relationshipScore") || 0, tags: report.getFlag(MOD_ID, "tags") || [], report: report };
    }

    static async updateRelationshipJournal(npcId, adjustment = 0, tag = null) {
        const npc = game.actors.get(npcId);
        const rel = await this.getOrCreateRelationship(npc.name);
        let newScore = rel.score + adjustment;
        let newTags = [...rel.tags];
        if (tag && !newTags.includes(tag)) newTags.push(tag);
        await rel.report.setFlag(MOD_ID, "relationshipScore", newScore);
        await rel.report.setFlag(MOD_ID, "tags", newTags);
        const status = newScore >= 5 ? "Freundlich" : (newScore <= -5 ? "Feindlich" : "Neutral");
        await rel.report.pages.contents[0].update({ "text.content": `<h3>Status: ${npc.name}</h3><p>Stimmung: ${newScore} (${status})</p><ul>${newTags.map(t => `<li>${t}</li>`).join("")}</ul>` });
        return { score: newScore, tags: newTags };
    }

    static async processChoice(data) {
        const session = this.activeSessions[data.npcId];
        if (session) {
            session.history.push(`<b>${data.speaker}:</b> ${data.text}`);
            if (data.systemLog) session.history.push(`<small><i>${data.systemLog}</i></small>`);
            if (data.nextNodeText) session.history.push(`<b>${game.actors.get(data.npcId).name}:</b> ${data.nextNodeText}`);
        }
    }

    static async endConversation(npcId) {
        const session = this.activeSessions[npcId];
        if (!session) return;
        const logTitle = `${game.actors.get(npcId).name} & ${session.pcName}`;
        let logsFolder = game.folders.find(f => f.name === "Logs");
        let logEntry = game.journal.find(j => j.name === logTitle && j.folder?.id === logsFolder?.id);
        const newContent = `<hr><h3>${new Date().toLocaleString()}</h3>` + session.history.map(h => `<p>${h}</p>`).join("");
        if (logEntry) {
            let page = logEntry.pages.contents[0];
            await page.update({ "text.content": (page.text.content || "") + newContent });
        } else {
            await JournalEntry.create({ name: logTitle, folder: logsFolder?.id, pages: [{ name: "Logs", type: "text", text: { content: newContent } }] });
        }
        delete this.activeSessions[npcId];
    }
}

class BG3DialogueWindow extends Application {
    constructor(npcId, pcId, fullTree, currentNodeKey, isObserver = false, relScore = 0, relTags = []) {
        super();
        this.npc = game.actors.get(npcId);
        this.pc = pcId ? game.actors.get(pcId) : null;
        this.fullTree = fullTree;
        this.currentNodeKey = currentNodeKey;
        this.isObserver = isObserver;
        this.relScore = relScore;
        this.relTags = relTags;
        this.insightResults = {};
    }

    static get defaultOptions() {
        return mergeObject(super.defaultOptions, { id: "bg3-dialog-ui", template: "modules/bg3-dialogue-system/templates/dialog.html", width: 700, height: "auto" });
    }

    async _render(force, options) {
        const node = this.fullTree[this.currentNodeKey];
        
        // NEU: Stimmung & Tags werden SOFORT beim Laden des Knotens verarbeitet
        if (!this.isObserver && node) {
            if (node.ship_mod || node.ship_tag) {
                const res = await BG3DialogueSystem.updateRelationshipJournal(this.npc.id, node.ship_mod || 0, node.ship_tag);
                this.relScore = res.score;
                if (node.ship_tag && !this.relTags.includes(node.ship_tag)) this.relTags.push(node.ship_tag);
            }
            await this._handleReactiveInsight();
        }
        return super._render(force, options);
    }

    async _handleReactiveInsight() {
        const node = this.fullTree[this.currentNodeKey];
        if (node.reactive_check && this.insightResults[this.currentNodeKey] === undefined) {
            const roll = await new Roll("1d20").evaluate();
            const success = (roll.total + (this.pc?.system.skills[node.reactive_check.skill]?.total || 0)) >= (node.reactive_check.dc + this._getDCMod());
            this.insightResults[this.currentNodeKey] = success;
            if (success && node.reactive_check.ship_tag) {
                await BG3DialogueSystem.updateRelationshipJournal(this.npc.id, 0, node.reactive_check.ship_tag);
                if (!this.relTags.includes(node.reactive_check.ship_tag)) this.relTags.push(node.reactive_check.ship_tag);
            }
        }
    }

    _getDCMod() { return this.relScore <= -5 ? 5 : (this.relScore < 0 ? 2 : (this.relScore >= 5 ? -5 : (this.relScore > 0 ? -2 : 0))); }

    getData() {
        const node = this.fullTree[this.currentNodeKey];
        const opts = (node?.options || []).filter(o => !o.condition_tag || this.relTags.includes(o.condition_tag)).map(o => {
            let txt = o.text;
            if (o.check && this.pc) txt = txt.replace(/\[(.*?)\]/, `[$1 ${this.pc.system.skills[o.check].total >= 0 ? '+' : ''}${this.pc.system.skills[o.check].total}]`);
            return { ...o, displayHtml: txt };
        });
        return { 
            npcName: this.npc.name, npcImg: this.npc.img, pcImg: this.pc?.img, text: node?.text, options: opts, 
            relationshipStatus: { class: this.relScore >= 5 ? "friendly" : (this.relScore <= -5 ? "hostile" : "neutral") },
            showInsight: this.insightResults[this.currentNodeKey], insightText: node?.reactive_check?.success_text, hasInspiration: this.pc?.system.attributes.inspiration
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find('.dialog-option').click(async ev => {
            if (this.isObserver) return;
            const node = this.fullTree[this.currentNodeKey];
            const opt = node.options[$(ev.currentTarget).data('index')];
            let nextKey = opt.nextNode, resTxt = "", speaker = this.pc?.name || game.user.name;

            if (opt.check && this.pc) {
                const roll = await new Roll("1d20").evaluate();
                const total = roll.total + this.pc.system.skills[opt.check].total;
                const success = total >= (opt.dc + this._getDCMod());
                nextKey = success ? opt.passNode : opt.failNode;
                resTxt = ` [Wurf: ${roll.total} vs SG ${opt.dc + this._getDCMod()} ➔ ${success ? 'ERFOLG' : 'FEHLSCHLAG'}]`;
            }

            dispatchSystemEvent({
                type: "choiceMade", npcId: this.npc.id, speaker: speaker, text: opt.text + resTxt,
                nextNodeText: this.fullTree[nextKey]?.text
            });

            if (nextKey) { this.currentNodeKey = nextKey; this.render(true); } 
            else { dispatchSystemEvent({ type: "closeObserver", npcId: this.npc.id }); this.close(); }
        });
    }
}