import at from 'core-js-pure/actual/array/at'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import slugify from 'slugify'
import * as yaml from 'js-yaml'
import { Injectable } from '@angular/core'
import { PartialProfile } from 'tabby-core'
import { SSHProfileImporter, PortForwardType, SSHProfile, SSHProfileOptions, AutoPrivateKeyLocator } from 'tabby-ssh'

import { ElectronService } from './services/electron.service'


@Injectable({ providedIn: 'root' })
export class OpenSSHImporter extends SSHProfileImporter {
    async getProfiles (): Promise<PartialProfile<SSHProfile>[]> {
        let results: PartialProfile<SSHProfile>[] = []
        const deriveID = name => 'openssh-config:' + slugify(name)
        const configPaths: string[] = [path.join(process.env.HOME ?? '~', '.ssh', 'config')]
        // eslint-disable-next-line @typescript-eslint/prefer-for-of
        for (let index=0; index<configPaths.length; index++) {
            try {
                const lines = (await fs.readFile(configPaths[index], 'utf8')).split('\n')
                lines.filter(l => l.toLowerCase().startsWith('include')).
                    map(l => l.substring(7).trim()).
                    map(p => p.startsWith('~') ? p : path.resolve(path.join(process.env.HOME ?? '~', '.ssh'), p)).
                    filter(inculdeConfigPath => !configPaths.includes(inculdeConfigPath)).
                    forEach((inculdeConfigPath, _) => configPaths.push(inculdeConfigPath))
                results = results.concat(this.getProfilesFromConfig(deriveID, configPaths[index], lines))
            } catch (e) {
                console.log(e)
            }
        }
        return results
    }

    private getProfilesFromConfig (deriveID: (name: any) => string, configPath, lines: string[]): PartialProfile<SSHProfile>[] {
        const results: PartialProfile<SSHProfile>[] = []
        const globalOptions: Partial<SSHProfileOptions> = {}
        let currentProfile: PartialProfile<SSHProfile>|null = null
        for (let line of lines) {
            if (line.trim().startsWith('#') || !line.trim()) {
                continue
            }
            if (line.toLowerCase().startsWith('host ')) {
                if (currentProfile) {
                    results.push(currentProfile)
                }
                const name = line.substr(5).trim()
                currentProfile = {
                    id: deriveID(name),
                    name: `${name} (${configPath})`,
                    type: 'ssh',
                    group: `Imported from ${configPath}`,
                    options: {
                        ...globalOptions,
                        host: name,
                    },
                }
            } else {
                const target: Partial<SSHProfileOptions> = currentProfile?.options ?? globalOptions
                line = line.trim()
                const idx = /\s/.exec(line)?.index ?? -1
                if (idx === -1) {
                    continue
                }
                const key = line.substr(0, idx).trim()
                const value = line.substr(idx + 1).trim()

                if (key === 'IdentityFile') {
                    target.privateKeys = value.split(',').map(s => s.trim()).map(s => {
                        if (s.startsWith('~')) {
                            s = path.join(process.env.HOME ?? '~', s.slice(2))
                        }
                        return s
                    })
                } else if (key === 'RemoteForward') {
                    const bind = value.split(/\s/)[0].trim()
                    const tgt = value.split(/\s/)[1].trim()
                    target.forwardedPorts ??= []
                    target.forwardedPorts.push({
                        type: PortForwardType.Remote,
                        description: value,
                        host: bind.split(':')[0] ?? '127.0.0.1',
                        port: parseInt(bind.split(':')[1] ?? bind),
                        targetAddress: tgt.split(':')[0],
                        targetPort: parseInt(tgt.split(':')[1]),
                    })
                } else if (key === 'LocalForward') {
                    const bind = value.split(/\s/)[0].trim()
                    const tgt = value.split(/\s/)[1].trim()
                    target.forwardedPorts ??= []
                    target.forwardedPorts.push({
                        type: PortForwardType.Local,
                        description: value,
                        host: bind.includes(':') ? bind.split(':')[0] : '127.0.0.1',
                        port: parseInt(at(bind.split(':'), -1)),
                        targetAddress: tgt.split(':')[0],
                        targetPort: parseInt(tgt.split(':')[1]),
                    })
                } else if (key === 'DynamicForward') {
                    const bind = value.trim()
                    target.forwardedPorts ??= []
                    target.forwardedPorts.push({
                        type: PortForwardType.Dynamic,
                        description: value,
                        host: bind.includes(':') ? bind.split(':')[0] : '127.0.0.1',
                        port: parseInt(at(bind.split(':'), -1)),
                        targetAddress: '',
                        targetPort: 22,
                    })
                } else {
                    const mappedKey = {
                        hostname: 'host',
                        host: 'host',
                        port: 'port',
                        user: 'user',
                        forwardx11: 'x11',
                        serveraliveinterval: 'keepaliveInterval',
                        serveralivecountmax: 'keepaliveCountMax',
                        proxycommand: 'proxyCommand',
                        proxyjump: 'jumpHost',
                    }[key.toLowerCase()]
                    if (mappedKey) {
                        target[mappedKey] = value
                    }
                }
            }
        }
        if (currentProfile) {
            results.push(currentProfile)
        }
        for (const p of results) {
            if (p.options?.proxyCommand) {
                p.options.proxyCommand = p.options.proxyCommand
                    .replace('%h', p.options.host ?? '')
                    .replace('%p', (p.options.port ?? 22).toString())
            }
            if (p.options?.jumpHost) {
                p.options.jumpHost = deriveID(p.options.jumpHost)
            }
        }
        return results
    }
}

@Injectable({ providedIn: 'root' })
export class StaticFileImporter extends SSHProfileImporter {
    private configPath: string

    constructor (
        electron: ElectronService,
    ) {
        super()
        this.configPath = path.join(electron.app.getPath('userData'), 'ssh-profiles.yaml')
    }

    async getProfiles (): Promise<PartialProfile<SSHProfile>[]> {
        const deriveID = name => 'file-config:' + slugify(name)

        if (!fsSync.existsSync(this.configPath)) {
            return []
        }

        const content = await fs.readFile(this.configPath, 'utf8')
        if (!content) {
            return []
        }

        return (yaml.load(content) as PartialProfile<SSHProfile>[]).map(item => ({
            ...item,
            id: deriveID(item.name),
            type: 'ssh',
        }))
    }
}


@Injectable({ providedIn: 'root' })
export class PrivateKeyLocator extends AutoPrivateKeyLocator {
    async getKeys (): Promise<[string, Buffer][]> {
        const results: [string, Buffer][] = []
        const keysPath = path.join(process.env.HOME!, '.ssh')
        if (!fsSync.existsSync(keysPath)) {
            return results
        }
        for (const file of await fs.readdir(keysPath)) {
            if (/^id_[\w\d]+$/.test(file)) {
                const privateKeyContents = await fs.readFile(
                    path.join(keysPath, file),
                    { encoding: null },
                )
                results.push([file, privateKeyContents])
            }
        }
        return results
    }
}
