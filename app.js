var http = require('http');
var fs = require('fs');
var qs = require('querystring');
var colors = require('colors');
var evilscan = require("evilscan");var async = require('async');
var express = require('express');
var e = require('events');
var bodyParser = require("body-parser");
var path_module = require('path');

require('events').EventEmitter.prototype._maxListeners = 0;

var GAME_NAME = "redblue1";
var CLAIM_DELAY = 30000;
var SCAN_DELAY = 500;
var PORT_OPEN_SCORE = 3;
var PORT_CLOSED_SCORE = 0;
var BOX_OWNERSHIP_SCORE = 1;
var EXP_SCORING = true;
var EXP_VAL = 60;
var d = new Date();

var path = __dirname + "/games/" + GAME_NAME;
var save_path = path + "/saved/network";
var checks_path = "./checks";
var services = {
    "FTP": "CheckPort",
    "SSH": "CheckPort",
    "HTTP": "CheckPort",
};
var environment = {};
environment["ownership"] = {};
environment["claim_times"] = {}
environment["scores"] = {};
environment["ports"] = {};
environment["messages"] = [];
environment["scoring_iteration"] = 0;
environment["chart_scores"] = [];
environment["teams"] = {"Red Team" : "red", "Blue Team" : "blue", "Green Team" : "green", "Purple Team" : "purple", "Yellow Team": "yellow"};
environment["ignore"] = ["Red Team"];
initialize_network(); //generate the gui graph

var index = fs.readFileSync(__dirname + '/index.html');
var app = require('express')();
var server = require('http').Server(app);
var scorebot = require('express')();
var scorebot_server = require('http').Server(scorebot);
var io = require('socket.io')(server);
//var checks = import_checks(checks_path);
//console.log(checks);

import_checks(checks_path).then(function (cs) {
    var checks = cs;
    var scanner = setInterval(function() { scan_net() }, SCAN_DELAY);
}).catch(function(err) {
    console.log(err);
    console.log('Failed to import checks: ');
});

//set up routing information
app.use('/static', express.static('./static'));
scorebot.use(bodyParser.urlencoded({ extended: false }));
scorebot.use(bodyParser.json());
server.listen(3000);
scorebot.listen(8000);

app.get('/', function (req, res) { res.sendFile(__dirname + '/index.html'); });
scorebot.get("/", function (req, res) { handle(req, res, req.param("team")); });
scorebot.post("/", function(req, res) { handle(req, res, req.body.team); });

calculate_score();
// Emit current data on connection
io.on('connection', function(socket) {
    socket.emit('data', {
        graph: environment["graph"],
        chart: environment["chart_scores"],
        teams: environment["teams"],
        messages: environment["messages"],
        ports: environment["ports"], //TODO UPDATE THIS TO SERVICES
        machines: environment["machines"],
        ignore: environment["ignore"]
    });
});

function handle(req, res, team_name) {
    var body='';
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket.remoteAddress;
    claim_times = environment["claim_times"];
    id = check_valid(ip);

    console.log("Attempted claim from " + ip + " on machine id " + id + " for team " + team_name);
    if(team_name in teams && id != "") {
        now = new Date();

        if(id in claim_times && team_name in claim_times[id] && now.getTime() - claim_times[id][team_name] < CLAIM_DELAY) {
            res.write("Cannot claim box - please wait.");
            claim_times[id][team_name] = now.getTime()
        } else if(environment["machines"][id]["owner"] == team_name) {
            res.write("Team already owns this box - cannot reclaim.");
            claim_times[id][team_name] = now.getTime()
        } else {
            if(!(id in claim_times)) {
                claim_times[id] = {}
            }
            claim_times[id][team_name] = now.getTime();
            claim_machine(id, team_name);
            environment["machines"][id]["owner"] == team_name;
            messages.push(pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()) + " - <span class=\"ui " + teams[team] + " small inverted header\">" + team.cap() + "<\/span> team has claimed " + id + "<br/>");
            console.log(messages);
            res.write("Box claimed for team " + team_name + ".");
            console.log("Box " + id + " ("+ip+") claimed for team " + team_name + ".");
        }
    } else {
        res.write("Unknown team or machine.")
    }
    res.end();
}

String.prototype.cap = function() { return this.charAt(0).toUpperCase() + this.slice(1); }
Array.prototype.last = function() { return this[this.length - 1]; }
function pad(i) { return (i < 10 ? "0" : "") + i }
function first(arr) { return arr[0].toLowerCase(); }

function isEntry(name) {
    for(team in teams) {
        if (name.indexOf(team) > -1) {
            return teams[team];
        }
    }
    return undefined;
}

function count_open_ports(ports) {
    var num_open = 0;
    for(var port in ports) {
        if(ports[port] == "open") {
            num_open += 1;
        }
    }
    return num_open;
}

function import_checks(path) {
    checks = {}
    return new Promise(function (fulfill, reject) {
        fs.readdir(path, function(err, files) {
            var f, l = files.length;
            for (var i = 0; i < l; i++) {
                f = path_module.join(path, files[i]);
                if (fs.lstatSync(f).isFile()) {
                    mod = require("./" + f);
                    checks[mod.name] = mod
                }
            }
            console.log(checks);
            fulfill(checks);
        });
    });
}

function scan_net() {
    io.sockets.emit('scan', {
        chart: calculate_score(),
        graph: environment["graph"],
        machines: environment["machines"]
    });

    console.log("Starting network wide scan...");
    all_services = [];
    check_funcs = [];
    machines = Object.keys(environment["machines"]);
    for(i = 0; i < machines.length; i++) {
        machine = environment["machines"][machines[i]];
        local_services = Object.keys(machine["services"]);
        all_services = all_services.concat(local_services);
        for (j = 0; j < local_services.length; j++) {
            check_name = services[local_services[j]];
            console.log("[*] Instantiating service check for machine "+ machine["name"]+" for service " + local_services[j] + " with check " + check_name)
            mod = new checks[check_name](machine["name"], machine["ip"][0], machine["services"][local_services[j]]); //TODO ensure ip isn't empty
            console.log(mod);
            check_funcs.push(mod.check());
        }
    }
    console.log("[*] List of services in order that we're checking:")
    console.log(all_services)
    async.parallel(check_funcs, function(err, result) {
        console.log("[*] But my output is clobbered for no reason and looks like this: ")
        console.log(result);
        for (i = 0; i < result.length; i++) {
            //environment["machines"][result[i]["name"]]["services"][all_services[i]]["status"] = result[i]["status"];
        }
    });
        /*
        ip = get_ip(machine);
        id = machine["id"];
        if(ip != "::ffff:127.0.0.1" && ip.indexOf("/16") == -1 && name.indexOf("Red") == -1 && name != "Scorebot") { // && isEntry(id) == undefined &&
            scan_box(machine, ip, id);
        }*/

}

function scan_box(machine, ip, id) {
    options = {
        target:ip,
        port:Object.keys(machine["ports"]),
        status:'TROU', // Timeout, Refused, Open, Unreachable
        banner:false
    };

    var scanner = new evilscan(options);

    scanner.on('result', function(data) {
        if(data["status"].indexOf("closed") != -1) {
            machine[data["port"]] = "closed"; // ports open/closed set for ports {}
        } else {
            machine[data["port"]] = "open";
        }
    });
    scanner.run();
}

function claim_machine(id, team_name) {
    if(id in environment["machines"]) {
        environment["machines"][id]["color"] = teams[team_name];
        environment["machines"][id]["owner"] = team_name;
        io.sockets.emit('update', { id: id, color: teams[team_name] });
        return true;
    } else {
        return false;
    }
}

function get_team_by_color(color) {
    for(team in teams) {
        if(teams[team] == color) { return team; }
    }
    return null;
}

function calculate_score() {
    environment["scoring_iteration"] += 1;
    console.log("Calculating score...");
    s = {};
    ret = [];
    for(var name in environment["machines"]) {
        machine = environment["machines"][name];
        owner = machine["owner"];
        id = machine["id"];

        if(owner in environment["teams"]) {
            val = BOX_OWNERSHIP_SCORE;
            val += environment["scoring_iteration"] / EXP_VAL*val;
            val = Math.round(val * 100) / 100

            s[owner] = s[owner] + val || val
            num_open = 0;
            for(service in machine["services"]) {

                val = 0.0;
                if(machine["services"][service]["status"] == "open") {
                    val = PORT_OPEN_SCORE
                    num_open += 1;
                } else {
                    val = -1 * PORT_CLOSED_SCORE
                }
                val += environment["scoring_iteration"] / EXP_VAL*val
                val = Math.round(val * 100) / 100
                s[owner] += val + environment["scoring_iteration"]/EXP_VAL*val;
            }
            m = id;
        }
    }
    for(var team in s) {
        if(environment["scores"][team] == undefined) {
            environment["scores"][team] = [s[team]];
        } else {
            environment["scores"][team].push(environment["scores"][team].last() + s[team]);
        }
    }
    var i = 0;
    for(team in environment["scores"]) {
        ret[i] = [team];
        ret[i] = ret[i].concat(environment["scores"][team]);
        i++;
    }
    console.log(ret);
    environment["chart_scores"] = ret;

    save_network();
    return environment["chart_scores"];
}

function check_valid(ip) {
    for(var name in environment["machines"]) {
        machine = environment["machines"][name];
        if (machine["ip"].indexOf(ip) > -1) { return machine["id"]; }
    }
    return "";
}

function save_network() {
    /*fs.writeFileSync(save_path, JSON.stringify(environment, null, 4), 'utf-8', function(err) {
        if(err) { return console.log(err); }
    });*/
}

function initialize_network() {
    if (fs.existsSync(save_path)) {
        process.stdout.write("Reading save data file for " + GAME_NAME + "...");
        environment = JSON.parse(fs.readFileSync(save_path, 'utf8'));
        console.log("done".green);
    } else {
        try {
            //init = ; // /games/" + GAME_NAME +
            process.stdout.write("Reading initialization file for " + GAME_NAME + "...");
            network = JSON.parse(fs.readFileSync("network.json", 'utf8'));
            graph = {};
            graph["nodes"] = [];
            graph["edges"] = [];
            for(var router_id in network["routers"]) {
                router = network["routers"][router_id];
                node = {};
                node["data"] = {};
                node["data"]["id"] = router["id"];
                node["data"]["name"] = router["name"];
                node["data"]["weight"] = 5;
                node["data"]["color"] = "black";
                node["data"]["ip"] = router["ip"];
                graph["nodes"].push(node);
            }
            for(var name in network["machines"]) {
                machine = network["machines"][name];
                id = machine["id"]
                environment["ownership"][id] = machine["owner"];
                for(var j = 0; j < machine["connections"].length; j++) {
                    if(machine["connections"][j] in network["routers"]) {
                        edge = {}
                        edge["data"] = {}
                        edge["data"]["source"] = machine["connections"][j];
                        edge["data"]["target"] = id;
                        edge["data"]["color"] = "black";
                        edge["data"]["strength"] = 10;
                        graph["edges"].push(edge);
                    }
                }
                node = {};
                node["data"] = {};
                node["data"]["name"] = name;
                node["data"]["id"] = machine["id"];
                node["data"]["weight"] = 5;
                node["data"]["color"] = machine["color"];
                node["data"]["ip"] = machine["ip"];
                graph["nodes"].push(node);
            }
            environment["graph"] = graph;
            environment["machines"] = network["machines"];
            console.log("done".green);
        } catch (e) {
            console.log(e);
            console.log(e.stack);
            console.log("ERROR: No init or save file found.");
            return {};
        }
    }


}

function get_ip(machine) {
    for (j = 0; j < machine["ip"].length; j++) {
        if (machine["ip"][j] != null) {
            return machine["ip"][j];
        }
    }
}
