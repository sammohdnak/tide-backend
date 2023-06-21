import {
    GaugeFragment,
    GaugeLiquidityGaugesQueryVariables,
    GaugeShareFragment,
    GaugeSharesQueryVariables,
    GaugeShare_OrderBy,
    getSdk,
    LiquidityGauge_OrderBy,
    OrderDirection,
    VotingEscrowLock_OrderBy,
    PoolsQuery,
    GaugesInfoQuery,
    Chain,
    RootGaugesInfoQuery,
} from './generated/gauge-subgraph-types';
import { GraphQLClient } from 'graphql-request';
import { networkContext } from '../../network/network-context.service';
import moment from 'moment';
import _ from 'lodash';
import { getRequestScopeContextValue, setRequestScopedContextValue } from '../../context/request-scoped-context';

export type GaugeRewardToken = { id: string; decimals: number; symbol: string; rewardsPerSecond: string };

export type LiquidityGaugeWithStatus = {
    address: string;
    streamerAddress: string;
    totalSupply: string;
    poolId: string;
    tokens: GaugeRewardToken[];
    status: LiquidityGaugeStatus;
};

export type LiquidityGaugeStatus = 'KILLED' | 'ACTIVE' | 'PREFERRED';

export type GaugeUserShare = {
    gaugeAddress: string;
    poolId: string;
    amount: string;
    tokens: GaugeRewardToken[];
};

export type LiquidityGaugesInfo = Omit<GaugesInfoQuery['liquidityGauges'][number], '__typename'>[];
export type RootGaugesInfo = Omit<RootGaugesInfoQuery['rootGauges'][number], '__typename'>[];

export class GaugeSubgraphService {
    constructor() {}

    public async getGauges(args: GaugeLiquidityGaugesQueryVariables) {
        const gaugesQuery = await this.sdk.GaugeLiquidityGauges(args);
        return gaugesQuery.liquidityGauges;
    }

    public async getUserGauges(userAddress: string) {
        const userGaugesQuery = await this.sdk.GaugeUserGauges({ userAddress });
        return userGaugesQuery.user;
    }

    public async getGaugeShares(args: GaugeSharesQueryVariables) {
        const sharesQuery = await this.sdk.GaugeShares(args);
        return sharesQuery.gaugeShares;
    }

    public async getAllGaugeShares(): Promise<GaugeShareFragment[]> {
        const allGaugeShares: GaugeShareFragment[] = [];
        let hasMore = true;
        let id = `0`;
        const pageSize = 1000;

        while (hasMore) {
            const gauges = await this.sdk.GaugeShares({
                where: {
                    id_gt: id,
                },
                orderBy: GaugeShare_OrderBy.id,
                orderDirection: OrderDirection.asc,
                first: pageSize,
            });

            if (gauges.gaugeShares.length === 0) {
                break;
            }

            if (gauges.gaugeShares.length < pageSize) {
                hasMore = false;
            }

            allGaugeShares.push(...gauges.gaugeShares);
            id = gauges.gaugeShares[gauges.gaugeShares.length - 1].id;
        }
        return allGaugeShares;
    }

    public async getAllGaugesWithStatus(): Promise<LiquidityGaugeWithStatus[]> {
        const subgraphLiquidityGauges = await this.getAllGauges();

        const gauges: LiquidityGaugeWithStatus[] = [];
        for (let liquidityGauge of subgraphLiquidityGauges) {
            const tokens: GaugeRewardToken[] = [];
            liquidityGauge.tokens?.forEach((rewardToken) => {
                const isActive = moment.unix(parseInt(rewardToken.periodFinish || '0')).isAfter(moment());
                tokens.push({
                    ...rewardToken,
                    rewardsPerSecond: isActive ? rewardToken.rate || '0' : '0',
                });
            });

            const gaugesForSamePool = subgraphLiquidityGauges.filter(
                (gauge) => gauge.poolId === liquidityGauge.poolId && gauge.id !== liquidityGauge.id,
            );
            let gaugeStatus: LiquidityGaugeStatus = 'PREFERRED';

            if (liquidityGauge.isKilled) {
                gaugeStatus = 'KILLED';
            } else if (gaugesForSamePool.length > 0 && !liquidityGauge.isPreferentialGauge) {
                gaugeStatus = 'ACTIVE';
            }

            // when there are new v2 gauges added to the pool but are not active yet, we end up with multiple gauges for the same pool but none is marked as preferential

            gauges.push({
                address: liquidityGauge.id,
                streamerAddress: liquidityGauge.streamer || '',
                totalSupply: liquidityGauge.totalSupply,
                poolId: liquidityGauge.poolId || '',
                tokens,
                status: gaugeStatus,
            });
        }
        return gauges;
    }

    public async getAllGaugeAddresses(): Promise<string[]> {
        const allGauges = await this.getAllGauges();
        return allGauges.map((gauge) => gauge.id);
    }

    public async getAllUserShares(userAddress: string): Promise<GaugeUserShare[]> {
        const userGauges = await this.getUserGauges(userAddress);
        return (
            userGauges?.gaugeShares?.map((share) => ({
                gaugeAddress: share.gauge.id,
                poolId: share.gauge.poolId || '',
                amount: share.balance,
                tokens:
                    share.gauge.tokens?.map((token) => ({
                        ...token,
                        rewardsPerSecond: token.rate || '',
                    })) || [],
            })) ?? []
        );
    }

    // TODO needs proper paging, currently <3000 locks so it works
    async getAllveBalHolders(): Promise<{ user: string; balance: string }[]> {
        let skip = 0;
        const timestamp = String(Math.round(Date.now() / 1000));

        let locks: { user: string; balance: string }[] = [];

        // There is more than 1000 locks, so we need to paginate
        do {
            const locksQuery = await this.sdk.VotingEscrowLocks({
                first: 1000,
                skip,
                orderBy: VotingEscrowLock_OrderBy.id,
                orderDirection: OrderDirection.asc,
                where: {
                    unlockTime_gt: timestamp,
                },
            });

            locks = locks.concat(
                locksQuery.votingEscrowLocks.map((lock) => ({
                    user: lock.user.id,
                    balance: lock.lockedBalance,
                })),
            );

            if (locksQuery.votingEscrowLocks.length < 1000) {
                break;
            }

            skip += 1000;
        } while (1 === 1);

        return locks;
    }

    public async getPoolsWithGauges(poolIds: string[]): Promise<PoolsQuery> {
        const chunks = _.chunk(poolIds, 1000);
        const allPoolsWithGauges: PoolsQuery = { pools: [] };

        for (const chunk of chunks) {
            const poolsWithGauges = await this.sdk.Pools({
                where: {
                    poolId_in: chunk,
                },
                first: 1000,
            });

            allPoolsWithGauges.pools.push(...poolsWithGauges.pools);
        }

        return allPoolsWithGauges;
    }

    public async getAllGauges(): Promise<GaugeFragment[]> {
        const allLiquidityGauges: GaugeFragment[] = [];
        let hasMore = true;
        let id = `0`;
        const pageSize = 1000;

        while (hasMore) {
            const gauges = await this.sdk.GaugeLiquidityGauges({
                where: {
                    id_gt: id,
                },
                orderBy: LiquidityGauge_OrderBy.id,
                orderDirection: OrderDirection.asc,
                first: pageSize,
            });

            if (gauges.liquidityGauges.length === 0) {
                break;
            }

            if (gauges.liquidityGauges.length < pageSize) {
                hasMore = false;
            }

            allLiquidityGauges.push(...gauges.liquidityGauges);
            id = gauges.liquidityGauges[gauges.liquidityGauges.length - 1].id;
        }

        return allLiquidityGauges;
    }

    public async getMetadata() {
        const { meta } = await this.sdk.GaugeGetMeta();

        if (!meta) {
            throw new Error('Missing meta data');
        }
        return meta;
    }

    public async getGaugesInfo(poolIds: string[]): Promise<LiquidityGaugesInfo> {
        const { liquidityGauges } = await this.sdk.GaugesInfo({ poolIds });
        return liquidityGauges;
    }

    public async getGaugesStreamers(poolIds: string[]) {
        const { liquidityGauges } = await this.sdk.GaugeStreamers({ poolIds });
        return liquidityGauges;
    }

    public async getRootGaugesInfo(recipients: string[], chain: Chain): Promise<RootGaugesInfo> {
        const currentChainId = getRequestScopeContextValue('chainId');
        // Run query in MAINNET subgraph
        // Can we do it in a cleaner way?
        setRequestScopedContextValue('chainId', '1');

        const { rootGauges } = await this.sdk.RootGaugesInfo({ recipients, chain });

        setRequestScopedContextValue('chainId', currentChainId);

        return rootGauges;
    }

    public get sdk() {
        const client = new GraphQLClient(networkContext.data.subgraphs.gauge ?? '');

        return getSdk(client);
    }
}

export const gaugeSubgraphService = new GaugeSubgraphService();
