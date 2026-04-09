--[[----------------------------------------------------------------------------
    VS Code Configuration, NLS, and Manifest Generator
    ----------------------------------------------------------------------------
    PURPOSE:
    Automates the generation of JSON Schemas, Package NLS (Localization)
    files, and the extension manifest by merging base configurations with
    language-specific strings.

    FLOW:
    1. Scans 'submodules/server/locale/' for supported languages.
    2. Loads 'setting.lua' from each locale as the translation source.
    3. Injects diagnostic group documentation from 'diagnostic.lua'.
    4. Recursively maps 'configuration.lua' keys to localized values.
    5. Outputs formatted JSON for extension settings and VS Code marketplace.

    INPUTS:
    - submodules/server/locale/<lang>/setting.lua  : Source translation strings.
    - submodules/server/script/proto/diagnostic.lua: Diagnostic group metadata.
    - submodules/server/tools/configuration.lua   : The master schema structure.

    OUTPUTS:
    - setting/schema[-<lang>].json : VS Code settings UI schema.
    - package.nls[.<lang>].json    : Extension manifest translations.

    DEPENDENCIES:
    - bee.filesystem (File system operations)
    - json-beautify  (Formatted JSON output)
    - locale-loader  (Lua-based NLS parser)
----------------------------------------------------------------------------]]--

local fs = require 'bee.filesystem'

local currentPath = debug.getinfo(1, 'S').source:sub(2)
local rootPath = currentPath:gsub('[^/\\]-$', '')
package.path = package.path
    .. ';' .. rootPath .. 'submodules/server/script/?.lua' -- contains json-beautify, fs-utility, locale-loader, proto/diagnostic.lua, and utility
    .. ';' .. rootPath .. 'submodules/server/tools/?.lua' -- contains configuration

local configuration = require 'configuration'
local json          = require 'json-beautify'
local fsu           = require 'fs-utility'
local lloader       = require 'locale-loader'
local diagd         = require 'proto.diagnostic'
local util          = require 'utility'

local packagePath = 'submodules/client/package.json'
local packageEncodeOption = {
    newline = '\r\n',
    indent  = '\t',
}

local function addSplited(t, key, value)
    t[key] = value
    for pos in key:gmatch '()%.' do
        local left = key:sub(1, pos - 1)
        local right = key:sub(pos + 1)
        local nt = t[left] or {
            properties = {}
        }
        t[left] = nt
        addSplited(nt.properties, right, value)
    end
end

local function copyWithNLS(t, callback)
    local nt = {}
    local mt = getmetatable(t)
    if mt then
        setmetatable(nt, mt)
    end
    for k, v in pairs(t) do
        if type(v) == 'string' then
            v = callback(v) or v
        elseif type(v) == 'table' then
            v = copyWithNLS(v, callback)
        end
        nt[k] = v
        if type(k) == 'string' and k:sub(1, #'Lua.') == 'Lua.' then
            local shortKey = k:sub(#'Lua.' + 1)
            local ref = {
                ['$ref'] = '#/properties/' .. shortKey
            }
            addSplited(nt, shortKey, ref)
            nt[k] = nil
            nt[shortKey] = v
        end
    end
    return nt
end

local encodeOption = {
    newline = '\r\n',
    indent  = '    ',
}

local function mergeDiagnosticGroupLocale(locale)
    for groupName, names in pairs(diagd.diagnosticGroups) do
        local key = ('config.diagnostics.%s'):format(groupName)
        local list = {}
        for name in util.sortPairs(names) do
            list[#list+1] = ('* %s'):format(name)
        end
        local desc = table.concat(list, '\n')
        locale[key] = desc
    end
end


print("Starting schema and NLS generation...")
print("--------------------------------------")

local count = 0
for dirPath in fs.pairs(fs.path 'submodules/server/locale') do
    local lang    = dirPath:filename():string()
    local nlsPath = dirPath / 'setting.lua'

    io.write(string.format("[%s] Processing... ", lang))

    local text = fsu.loadFile(nlsPath)
    if not text then
        print("SKIP (setting.lua not found)")
        goto CONTINUE
    end

    local nls = lloader(text, nlsPath:string())
    mergeDiagnosticGroupLocale(nls)

    local setting = {
        title       = 'setting',
        description = 'Setting of sumneko.lua',
        type        = 'object',
        properties  = copyWithNLS(configuration, function (str)
            return str:gsub('^%%(.+)%%$', function (key)
                if not nls[key] then
                    nls[key] = "TODO: Needs documentation"
                end
                return nls[key]
            end)
        end),
    }

    local schemaName, nlsName
    if lang == 'en-us' then
        schemaName = 'setting/schema.json'
        nlsName    = 'package.nls.json'
    else
        schemaName = 'setting/schema-' .. lang .. '.json'
        nlsName    = 'package.nls.' .. lang .. '.json'
    end

    fsu.saveFile(fs.path(schemaName), json.beautify(setting, encodeOption))
    fsu.saveFile(fs.path("Build/TMP/" .. nlsName),    json.beautify(nls, encodeOption))

    print("DONE")
    print(string.format("    => Saved %s", schemaName))
    print(string.format("    => Saved %s", nlsName))

    count = count + 1
    ::CONTINUE::
end

print("--------------------------------------")
print(string.format("Finished! Processed %d languages.", count))
