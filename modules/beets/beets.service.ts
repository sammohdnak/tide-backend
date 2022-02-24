import { balancerSubgraphService } from '../balancer-subgraph/balancer-subgraph.service';
import { env } from '../../app/env';
import { GqlBeetsConfig, GqlBeetsProtocolData } from '../../schema';
import { getCirculatingSupply } from './beets';
import { fiveMinutesInMs } from '../util/time';
import { Cache, CacheClass } from 'memory-cache';
import { balancerService } from '../balancer/balancer.service';
import { blocksSubgraphService } from '../blocks-subgraph/blocks-subgraph.service';
import { sanityClient } from '../sanity/sanity';
import { cache } from '../cache/cache';
import { beetsBarService } from '../beets-bar-subgraph/beets-bar.service';
import { tokenPriceService } from '../token-price/token-price.service';
import _ from 'lodash';

const PROTOCOL_DATA_CACHE_KEY = 'beetsProtocolData';
const CONFIG_CACHE_KEY = 'beetsConfig';

export class BeetsService {
    cache: CacheClass<string, any>;

    constructor() {
        this.cache = new Cache<string, any>();
    }

    public async getProtocolData(): Promise<GqlBeetsProtocolData> {
        const memCached = this.cache.get(PROTOCOL_DATA_CACHE_KEY) as GqlBeetsProtocolData | null;

        if (memCached) {
            return memCached;
        }

        const cached = await cache.getObjectValue<GqlBeetsProtocolData>(PROTOCOL_DATA_CACHE_KEY);

        if (cached) {
            this.cache.put(PROTOCOL_DATA_CACHE_KEY, cached, 15000);

            return cached;
        }

        return this.cacheProtocolData();
    }

    public async cacheProtocolData(): Promise<GqlBeetsProtocolData> {
        const { totalSwapFee, totalSwapVolume, poolCount } = await balancerSubgraphService.getProtocolData({});

        const { beetsPrice, fbeetsPrice } = await tokenPriceService.getBeetsPrice();
        const circulatingSupply = parseFloat(await getCirculatingSupply());
        const block = await blocksSubgraphService.getBlockFrom24HoursAgo();
        const prev = await balancerSubgraphService.getProtocolData({ block: { number: parseInt(block.number) } });
        const pools = await balancerService.getPools();
        const { excludedPools } = await this.getConfig();
        const totalLiquidity = _.sumBy(
            pools.filter(
                (pool) =>
                    ![
                        '0x64b301e21d640f9bef90458b0987d81fb4cf1b9e00020000000000000000022e',
                        '0x3b998ba87b11a1c5bc1770de9793b17a0da61561000000000000000000000185',
                        '0x2ff1552dd09f87d6774229ee5eca60cf570ae291000000000000000000000186',
                    ].includes(pool.id),
            ),
            (pool) => (excludedPools.includes(pool.id) ? 0 : parseFloat(pool.totalLiquidity)),
        );

        for (const pool of pools) {
            if (parseFloat(pool.totalLiquidity) > 10_000_000) {
                console.log(pool.name, pool.id);
            }
        }

        const protocolData: GqlBeetsProtocolData = {
            totalLiquidity: `${totalLiquidity}`,
            totalSwapFee,
            totalSwapVolume,
            beetsPrice: `${beetsPrice}`,
            fbeetsPrice: `${fbeetsPrice}`,
            marketCap: `${beetsPrice * circulatingSupply}`,
            circulatingSupply: `${circulatingSupply}`,
            poolCount: `${poolCount}`,
            swapVolume24h: `${parseFloat(totalSwapVolume) - parseFloat(prev.totalSwapVolume)}`,
            swapFee24h: `${parseFloat(totalSwapFee) - parseFloat(prev.totalSwapFee)}`,
        };

        await cache.putObjectValue(PROTOCOL_DATA_CACHE_KEY, protocolData, 30);

        return protocolData;
    }

    public async getConfig(): Promise<GqlBeetsConfig> {
        const cached = this.cache.get(CONFIG_CACHE_KEY) as GqlBeetsConfig | null;

        if (cached) {
            return cached;
        }

        const config = await sanityClient.fetch(`
            *[_type == "config" && chainId == ${env.CHAIN_ID}][0]{
                ...,
                "homeFeaturedPools": homeFeaturedPools[]{
                    ...,
                    "image": image.asset->url
                },
                "homeNewsItems": homeNewsItems[]{
                    ...,
                    "image": image.asset->url
                }
            }
        `);

        const beetsConfig: GqlBeetsConfig = {
            pausedPools: config?.pausedPools ?? [],
            featuredPools: config?.featuredPools ?? [],
            homeFeaturedPools: config?.homeFeaturedPools ?? [],
            incentivizedPools: config?.incentivizedPools ?? [],
            blacklistedPools: config?.blacklistedPools ?? [],
            homeNewsItems: config?.homeNewsItems ?? [],
            poolFilters: config?.poolFilters ?? [],
            excludedPools: config?.excludedPools ?? [],
        };

        this.cache.put(CONFIG_CACHE_KEY, beetsConfig, fiveMinutesInMs);

        return beetsConfig;
    }
}

export const beetsService = new BeetsService();
